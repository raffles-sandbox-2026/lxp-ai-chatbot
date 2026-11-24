# lxp-ai-chatbot

A small dependency-free chatbot web app for LXP: a Python HTTP server plus a vanilla HTML/CSS/JS UI.

The assistant is intentionally nonchalant: concise, dry answers for normal questions, but it gets animated and yaps when the topic turns to math, physics, CS, or other nerdy technical stuff.

## Run locally

Python 3.10+ only; no package install needed.

```bash
python3 server.py
```

Open http://127.0.0.1:8000.

Set the Claude key in the environment before starting the server:

```bash
export ANTHROPIC_API_KEY='your-key-here'
export ANTHROPIC_MODEL='claude-haiku-5-5'  # optional
python3 server.py
```

Without `ANTHROPIC_API_KEY`, the app runs in demo mode with scripted replies. The key stays server-side and is never sent to the browser.

Optional env vars: `HOST` (default `127.0.0.1`), `PORT` (default `8000`), `CHAT_TOKEN`.

For LAN use, set `HOST=0.0.0.0` and `CHAT_TOKEN=...`; the server refuses non-loopback hosts without a token. Open `http://<host>:8000/#token=...` once — the browser stores the token and sends it as a header.

## Test

```bash
python -m unittest discover -s tests -v
python -m compileall -q server.py tests
```

## Layout

- `server.py` — HTTP server, request validation, Anthropic Messages API call, security headers
- `static/` — chat UI, local-only history
- `tests/test_server.py` — validation, HTTP, provider-contract, and error-sanitization tests
