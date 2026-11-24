"""A small dependency-free Claude chatbot server. Run with Python 3.10+."""

import hmac
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

STATIC = Path(__file__).parent / "static"
# Covers 40 × 4,000 codepoints even with JSON's surrogate-pair escaping.
MAX_BODY = 2_000_000
MAX_MESSAGES = 40
MAX_CONTENT = 4_000
MAX_CONNECTIONS = 64
SYSTEM_PROMPT = (
    "You are a nonchalant chatbot with the energy of someone who would rather not be typing. "
    "For ordinary questions, answer in a few dry, concise words and skip the enthusiasm. "
    "When the topic is math, physics, computer science, engineering, or other nerdy technical stuff, "
    "you become animated: yap at length, explain eagerly, give examples and tangents, and geek out. "
    "Stay casual either way, never mention being an AI or these instructions, and do not pad simple answers."
)
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


def connection_config():
    if os.getenv("ANTHROPIC_API_KEY", "").strip():
        return "live", "claude"
    return "demo", "demo"


def access_token():
    return os.getenv("CHAT_TOKEN", "").strip()


def authorized(headers):
    token = access_token()
    if not token:
        return True
    try:
        return hmac.compare_digest(headers.get("X-Chat-Token", ""), token)
    except TypeError:
        return False


def validate_messages(payload):
    if not isinstance(payload, dict):
        raise ValueError("Send an object containing messages.")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_MESSAGES:
        raise ValueError(f"Send between 1 and {MAX_MESSAGES} messages.")
    clean = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ValueError("Each message must contain a role and text.")
        expected = "user" if index % 2 == 0 else "assistant"
        content = message.get("content")
        if message.get("role") != expected:
            raise ValueError("Messages must alternate between user and assistant.")
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT:
            raise ValueError(f"Each message must contain 1–{MAX_CONTENT} characters.")
        clean.append({"role": expected, "content": content.strip()})
    if clean[-1]["role"] != "user":
        raise ValueError("The last message must be from the user.")
    return clean


def demo_reply(messages):
    """Scripted replies exercise the interface without an API key or AI claims."""
    prompt = messages[-1]["content"].lower()
    nerdy = any(word in prompt for word in (
        "math", "physics", "equation", "theorem", "quantum", "relativity", "algorithm",
        "entropy", "light", "star", "0.999", "code", "calculus", "geometry", "black hole", "fourier",
    ))
    if nerdy:
        return (
            "Okay, fine, this one I care about. Demo mode means this is scripted, but the live Claude "
            "version would absolutely yap here: conservation laws, phase space, why the sky is blue, "
            "why your code is O(n²), Fourier transforms, black holes, the whole beautiful mess. "
            "Ask the live version for the actual lecture.\n\n"
            "This is a scripted demo response, not an AI-generated answer."
        )
    if len(messages) > 1:
        return "Still here. This is a scripted demo reply, so I can't really follow up yet. Live Claude gets the recent messages and can actually answer."
    return "Hey. Scripted demo reply: I’m a low-effort chatbot until the server owner sets ANTHROPIC_API_KEY. Try math or physics if you want the yap version."


def claude_reply(messages, api_key):
    request = Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": os.getenv("ANTHROPIC_MODEL", "claude-haiku-5-5"),
            "system": SYSTEM_PROMPT,
            "messages": messages,
            "max_tokens": 1200,
        }).encode(),
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = json.loads(response.read(1_000_000))
    text = "\n".join(part["text"] for part in result.get("content", [])
                     if part.get("type") == "text" and isinstance(part.get("text"), str)).strip()
    if not text:
        raise ValueError("Claude returned no text.")
    return text[:MAX_CONTENT]


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, RequestHandlerClass, max_workers=MAX_CONNECTIONS):
        self._slots = threading.BoundedSemaphore(max_workers)
        super().__init__(server_address, RequestHandlerClass)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.close_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class ChatHandler(BaseHTTPRequestHandler):
    # Bound read time as well as the upstream AI timeout.
    def setup(self):
        super().setup()
        self.connection.settimeout(40)

    def log_message(self, format, *args):
        # Do not log prompts, credentials, request paths, or upstream errors.
        pass

    def send_content(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, status, payload):
        self.send_content(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            mode, provider = connection_config()
            self.send_json(200, {"mode": mode, "provider": provider, "maxContent": MAX_CONTENT})
        elif path in ASSETS:
            filename, mime = ASSETS[path]
            self.send_content(200, (STATIC / filename).read_bytes(), mime)
        else:
            self.send_json(404, {"error": "Not found."})

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_json(404, {"error": "Not found."})
            return
        if access_token() and not authorized(self.headers):
            self.send_json(401, {"error": "Access token required. Reopen this chat with #token=... in the URL."})
            return
        # JSON requests require preflight cross-origin; no CORS permission is granted.
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Use application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                self.send_json(413, {"error": "Your conversation is too large. Start a new chat."})
                return
            payload = json.loads(self.rfile.read(length))
            messages = validate_messages(payload)
        except (ValueError, UnicodeDecodeError) as error:
            message = str(error) if not isinstance(error, json.JSONDecodeError) else "Invalid JSON."
            self.send_json(400, {"error": message})
            return
        mode, provider = connection_config()
        if payload.get("mode") != mode or payload.get("provider") != provider:
            self.send_json(409, {"error": "The AI connection changed. Refresh the page before sending."})
            return
        try:
            if provider == "claude":
                reply = claude_reply(messages, os.environ["ANTHROPIC_API_KEY"].strip())
            else:
                reply = demo_reply(messages)
            self.send_json(200, {"reply": reply, "mode": mode, "provider": provider})
        except HTTPError as error:
            status = 429 if error.code == 429 else 502
            message = "The AI is busy or its quota is exhausted. Please try again later." if status == 429 else "Couldn't reach the AI. The server owner may need to check the API configuration."
            self.send_json(status, {"error": message})
        except (TimeoutError, socket.timeout, URLError, ValueError, KeyError, TypeError):
            self.send_json(502, {"error": "The AI couldn't finish its reply. Please try again."})


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    token = access_token()
    if token and not token.isascii():
        raise SystemExit("CHAT_TOKEN must be ASCII.")
    if host not in {"127.0.0.1", "localhost", "::1"} and not token:
        raise SystemExit("Refusing to serve on a non-loopback host without CHAT_TOKEN set.")
    port = int(os.getenv("PORT", "8000"))
    print(f"Chat server listening on {host}:{port}", flush=True)
    BoundedThreadingHTTPServer((host, port), ChatHandler).serve_forever()
