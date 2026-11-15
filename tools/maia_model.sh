#!/bin/bash
# Makes engine/maia2_rapid.onnx, the model maia.js plays the free bots with: CSSLab's Maia-2 "rapid" (MIT), fetched by
# the maia2 package (it checks the file's sha256), exported to ONNX and checked against PyTorch on 20 positions.
# A copy already made ($MAIA_CACHE/maia2_rapid.onnx) is just copied. Needs uv. Usage: tools/maia_model.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${MAIA_WORK:-$HOME/Library/GameNest/Work/maia2}
CACHE=${MAIA_CACHE:-$HOME/Library/GameNest/Cache/maia2}
OUT=$HERE/engine/maia2_rapid.onnx
if [ -f "$CACHE/maia2_rapid.onnx" ]; then cp "$CACHE/maia2_rapid.onnx" "$OUT"; echo "copied $OUT"; exit 0; fi
mkdir -p "$WORK" "$CACHE"
[ -x "$WORK/.venv/bin/python" ] || uv venv -q --python 3.11 "$WORK/.venv"
VIRTUAL_ENV=$WORK/.venv uv pip install -q maia2==0.11.0 torch==2.8.0 onnx==1.23.2 onnxruntime==1.31.0 chess==1.11.2
cat > "$WORK/export.py" <<'PY'
import sys, random, json, torch, numpy as np, onnxruntime as ort, chess
from maia2 import model as M, inference, utils
work, out, moves_out = sys.argv[1:4]
m = M.from_pretrained(type="rapid", device="cpu", save_root=work + "/models").eval()
class Wrap(torch.nn.Module):
    def __init__(self, m): super().__init__(); self.m = m
    def forward(self, boards, elo_self, elo_oppo):
        a, _, v = self.m(boards, elo_self, elo_oppo); return a, v
w = Wrap(m).eval()
n = {0: "n"}
torch.onnx.export(w, (torch.zeros(2, 18, 8, 8), torch.tensor([3, 5]), torch.tensor([3, 5])), out,
    input_names=["boards", "elo_self", "elo_oppo"], output_names=["logits_move", "logits_value"],
    dynamic_axes={"boards": n, "elo_self": n, "elo_oppo": n, "logits_move": n, "logits_value": n}, opset_version=17, dynamo=False)
assert json.load(open(moves_out)) == utils.get_all_possible_moves(), "engine/maia2_moves.json is not this model's move list"
m.eval(); prep = inference.prepare(); s = ort.InferenceSession(out); random.seed(1); worst = 0
for g in range(20):
    b = chess.Board()
    for _ in range(random.randint(0, 60)):
        if b.is_game_over(): break
        b.push(random.choice(list(b.legal_moves)))
    if b.is_game_over(): continue
    bi, es, eo, _ = inference.preprocessing(b.fen(), 1500, 1500, prep[1], prep[0])
    with torch.no_grad(): ta, _, tv = m(bi[None], torch.tensor([es]), torch.tensor([eo]))
    oa, ov = s.run(None, {"boards": bi[None].numpy(), "elo_self": np.array([es]), "elo_oppo": np.array([eo])})
    worst = max(worst, float(np.abs(ta.numpy() - oa).max()), float(np.abs(tv.numpy() - ov).max()))
assert worst < 1e-3, worst
print("onnx matches torch (worst %.1e)" % worst)
PY
"$WORK/.venv/bin/python" -I "$WORK/export.py" "$WORK" "$CACHE/maia2_rapid.onnx" "$HERE/engine/maia2_moves.json"
cp "$CACHE/maia2_rapid.onnx" "$OUT"; echo "made $OUT"
