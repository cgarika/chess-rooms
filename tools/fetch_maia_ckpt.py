# Fetches Maia-2 rapid's original checkpoint (MIT) from a pinned Hugging Face revision and checks its sha256 (the same sha256 the maia2
# package itself pins for its Google Drive copy). Usage: python fetch_maia_ckpt.py <repo> <revision> <path in repo> <sha256> <dest>
import hashlib, os, sys, time, urllib.request
repo, rev, path, want, dest = sys.argv[1:6]
url = f"https://huggingface.co/{repo}/resolve/{rev}/{path}"
os.makedirs(os.path.dirname(dest), exist_ok=True)
for attempt in range(1, 6):
    try:
        h = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=120) as r, open(dest + ".part", "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                h.update(b)
                f.write(b)
        got = h.hexdigest()
        if got != want:
            raise SystemExit(f"sha256 mismatch for {url}: got {got}, want {want}")
        os.replace(dest + ".part", dest)
        print(f"fetched {path} ({os.path.getsize(dest)} bytes, sha256 ok)")
        break
    except SystemExit:
        raise
    except Exception as e:
        print(f"attempt {attempt}: {e}")
        time.sleep(5 * attempt)
else:
    raise SystemExit(f"could not fetch {url}")
