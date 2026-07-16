#!/usr/bin/env python3
"""
subdomain_finder_notimeout.py

Passive subdomain discovery via crt.sh (Certificate Transparency logs)
+ active check to see which discovered subdomains respond over HTTP/HTTPS.

Request timeouts are DISABLED (requests calls are made with timeout=None),
so requests wait indefinitely for a response instead of erroring out. This
trades "fails fast with a retry" for "never gives up on a slow response" —
useful on flaky/slow networks, but a genuinely dead host can hang forever
unless you Ctrl+C.

USAGE:
    ./subdomain_finder_notimeout.py example.com
    ./subdomain_finder_notimeout.py example.com --threads 30
    ./subdomain_finder_notimeout.py example.com --retries 8 --alive-retries 2

REQUIREMENTS:
    pip install requests

ONLY run this against domains you own or are authorized to test.
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    print("[!] The 'requests' package is required. Install it with: pip install requests")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_THREADS = 20         # concurrent liveness-check jobs
DEFAULT_ALIVE_RETRIES = 2    # retry attempts per scheme (http/https) on connection errors
DEFAULT_CRT_RETRIES = 8      # max retry attempts for crt.sh on 429/500/502/503/504 or empty results

RETRY_BACKOFF_BASE = 5        # seconds; grows as BASE * attempt
RETRY_BACKOFF_MAX = 60        # cap so it doesn't grow unbounded

RETRYABLE_STATUSES = {429, 500, 502, 503, 504}

USER_AGENT = "Mozilla/5.0"


def backoff_sleep(attempt: int) -> None:
    wait = min(RETRY_BACKOFF_BASE * attempt, RETRY_BACKOFF_MAX)
    print(f"[*] Waiting {wait}s before retrying (crt.sh rate-limit cooldown)...")
    time.sleep(wait)


def get_subdomains(domain: str, crt_retries: int, raw_file: str) -> bool:
    """Query crt.sh, with retry on throttling/empty responses.
    Writes results to raw_file. Returns True on success, False otherwise.
    """
    url = f"https://crt.sh/?q=%25.{domain}&output=json"

    for attempt in range(1, crt_retries + 1):
        print(f"[*] Querying crt.sh for subdomains of: {domain} (attempt {attempt}/{crt_retries}, no timeout)...")

        try:
            # timeout=None -> waits indefinitely for a response
            resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=None)
        except requests.exceptions.RequestException as e:
            print(f"[!] Attempt {attempt}/{crt_retries} failed (connection error: {e}). Retrying...")
            if attempt < crt_retries:
                backoff_sleep(attempt)
            continue

        http_code = resp.status_code
        print(f"HTTP Status: {http_code}")

        if http_code in RETRYABLE_STATUSES:
            print(f"[!] Attempt {attempt}/{crt_retries}: got HTTP {http_code} (server likely overloaded/rate-limiting). Retrying...")
            if attempt < crt_retries:
                backoff_sleep(attempt)
            continue

        if not (200 <= http_code < 300):
            print(f"[!] Error contacting crt.sh: HTTP {http_code}")
            if attempt < crt_retries:
                backoff_sleep(attempt)
                continue
            return False

        try:
            data = resp.json()
        except ValueError:
            print("[!] crt.sh returned invalid JSON (it may be rate-limiting you).")
            if attempt < crt_retries:
                backoff_sleep(attempt)
                continue
            return False

        record_count = len(data)
        print(f"Number of records: {record_count}")

        if record_count == 0:
            if attempt < crt_retries:
                print("[!] Got 0 records — likely a rate-limit, not a real empty result. Retrying...")
                backoff_sleep(attempt)
                continue
            else:
                print("[!] Still 0 records after all retries — treating as a genuine empty result.")
                return False

        # Extract name_value fields, split on newlines, normalize, filter,
        # and keep only entries that end with the target domain.
        subdomains = set()
        for entry in data:
            name_value = entry.get("name_value", "")
            for line in name_value.splitlines():
                line = line.strip().lower()
                if not line:
                    continue
                if line.startswith("*."):
                    line = line[2:]
                if "*" in line:
                    continue
                if line.endswith(domain):
                    subdomains.add(line)

        sorted_subs = sorted(subdomains)
        print(f"Subdomains collected: {len(sorted_subs)}")

        with open(raw_file, "w") as f:
            for s in sorted_subs:
                f.write(s + "\n")

        return True

    print(f"[!] Giving up after {crt_retries} attempts.")
    return False


def check_alive(subdomain: str, retries: int):
    """Try HTTPS then HTTP, no timeout, retrying connection errors.
    Returns (url, status_code, scheme) on success, or None on failure.
    """
    for scheme in ("https", "http"):
        url = f"{scheme}://{subdomain}"
        for attempt in range(1, retries + 1):
            try:
                # timeout=None -> no timeout; allow_redirects mirrors curl -L
                resp = requests.get(url, allow_redirects=True, timeout=None)
                return (url, resp.status_code, scheme)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
                # analogous to curl exit 6 (resolve failure) / 7 (connect failure) -> retry this scheme
                continue
            except requests.exceptions.RequestException:
                # non-retryable error (e.g. SSL/cert error) -> try next scheme
                break
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Passive subdomain discovery via crt.sh + liveness check (no timeouts)."
    )
    parser.add_argument("domain", help="Target domain, e.g. example.com")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS,
                         help=f"Concurrent liveness-check jobs (default: {DEFAULT_THREADS})")
    parser.add_argument("--alive-retries", type=int, default=DEFAULT_ALIVE_RETRIES,
                         help=f"Retry attempts per scheme http/https on connection errors during "
                              f"liveness checks (default: {DEFAULT_ALIVE_RETRIES})")
    parser.add_argument("--retries", type=int, default=DEFAULT_CRT_RETRIES,
                         help=f"Max retry attempts for crt.sh on rate-limit/server errors or empty "
                              f"responses (default: {DEFAULT_CRT_RETRIES})")
    args = parser.parse_args()

    domain = args.domain.strip().lower()

    raw_file = f"subdomains_raw_{domain}.txt"
    alive_file = f"subdomains_alive_{domain}.txt"

    if not get_subdomains(domain, args.retries, raw_file):
        print("[!] No subdomains found.")
        sys.exit(0)

    with open(raw_file) as f:
        subdomains = [line.strip() for line in f if line.strip()]

    sub_count = len(subdomains)
    print(f"[+] Found {sub_count} unique subdomains (saved to {raw_file})")

    print(f"[*] Checking liveness with {args.threads} threads (no timeout, retries={args.alive_retries})...")

    alive_results = set()

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        futures = {
            executor.submit(check_alive, sub, args.alive_retries): sub
            for sub in subdomains
        }
        for future in as_completed(futures):
            sub = futures[future]
            result = future.result()
            if result:
                url, code, scheme = result
                print(f"[ALIVE][{scheme}] {sub} -> {code}")
                alive_results.add(f"{url} [{code}]")

    with open(alive_file, "w") as f:
        for line in sorted(alive_results):
            f.write(line + "\n")

    alive_count = len(alive_results)

    print()
    print(f"[+] Done. {alive_count} alive subdomains saved to: {alive_file}")
    print("==================================================")
    print(f"Total Found : {sub_count}")
    print(f"Alive       : {alive_count}")
    print("==================================================")


if __name__ == "__main__":
    main()
