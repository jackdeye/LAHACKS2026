"""
Probe the Spark's Ollama instance from the backend host.

Usage:
    python test_ollama.py             # uses OLLAMA_URL/OLLAMA_MODEL from .env
    python test_ollama.py http://100.x.x.x:11434 qwen2.5-coder:32b

Verifies: connectivity, model presence, sample generation, tok/s.
"""
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

BASE = sys.argv[1] if len(sys.argv) > 1 else os.getenv("OLLAMA_URL", "http://localhost:11434")
MODEL = sys.argv[2] if len(sys.argv) > 2 else os.getenv("OLLAMA_MODEL", "llama3.1:70b")

print(f"→ Ollama:  {BASE}")
print(f"→ Model:   {MODEL}")
print()

with httpx.Client(timeout=180.0) as client:
    # 1) reachable?
    try:
        r = client.get(f"{BASE}/api/tags")
        r.raise_for_status()
    except Exception as e:
        print(f"FAIL: cannot reach {BASE} — {e}")
        sys.exit(1)
    tags = [m["name"] for m in r.json().get("models", [])]
    print(f"✓ Reachable. {len(tags)} model(s) installed:")
    for t in tags:
        print(f"    - {t}")
    if MODEL not in tags:
        print(f"\nFAIL: model '{MODEL}' not in `ollama list` on the server.")
        print(f"      Run on the Spark: ollama pull {MODEL}")
        sys.exit(2)

    # 2) sample generation
    print(f"\n→ Generating sample (1 short C++ snippet)…")
    t0 = time.perf_counter()
    r = client.post(
        f"{BASE}/api/generate",
        json={
            "model": MODEL,
            "prompt": "Write a one-line Arduino C++ statement that turns pin 13 on. No markdown, no explanation.",
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 64},
        },
    )
    r.raise_for_status()
    data = r.json()
    elapsed = time.perf_counter() - t0
    tok = data.get("eval_count", 0)
    eval_ns = data.get("eval_duration", 0)
    rate = (tok / (eval_ns / 1e9)) if eval_ns else 0
    print(f"✓ Response in {elapsed:.1f}s ({tok} tokens, {rate:.1f} tok/s)")
    print(f"\n  >>> {data.get('response', '').strip()}")
    print()
    print("Backend ↔ LLM link is healthy.")
