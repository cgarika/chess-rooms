# Maia-2 "rapid" (CSSLab, MIT) exported to ONNX for maia.js, exactly as tools/maia_model.sh does it on the Mac (this is that script's
# Python, unchanged), checked against PyTorch on 20 positions. Usage: python maia_export.py <work dir> <out .onnx> <engine/maia2_moves.json>
# <work dir>/models/rapid_model.pt must already be there (the production image fetches it from Hugging Face, sha256-checked, so the maia2
# package never needs Google Drive; maia2 checks the same sha256 again).
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
