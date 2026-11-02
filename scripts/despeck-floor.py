# Regenerates client/public/table-floor.jpg from the design painting: finds the painted ember specks in the arena floor (small, warm, brighter than their surroundings, not part
# of a crack) and paint them out. Usage: python despeck.py <in.jpg> <out.jpg> <preview-dir>
import sys, cv2, numpy as np
src, dst, prev = sys.argv[1:4]
img = cv2.imread(src)
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
h, s, v = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
# brighter than the neighbourhood: a speck pops against the stone around it
local = cv2.medianBlur(hsv[..., 2], 21).astype(int)
warm = (h <= 28) & (s >= 90) & (v >= 120) & (v - local >= 45)
mask = warm.astype(np.uint8) * 255
# any glow at all (a looser test): the glowing cracks, the ring, torch light
glow = ((h <= 30) & (s >= 45) & (v >= 85)).astype(np.uint8)
H, W = mask.shape
# the ritual circle and its rune ring are left alone (no floating embers there in the design anyway)
cy, cx, cr = int(H * 0.411), int(W * 0.5025), int(W * 0.21)
yy, xx = np.ogrid[:H, :W]
protected = (yy - cy) ** 2 + (xx - cx) ** 2 <= cr ** 2
n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
keep = np.zeros_like(mask)
removed = kept_crack = 0
for i in range(1, n):
    x, y, w, hh, area = stats[i]
    if area > 160 or w > 24 or hh > 30:
        continue  # too big: a crack, the ring, a torch
    if max(w, hh) > 6.5 * max(1, min(w, hh)):
        continue  # a thin line segment
    if protected[y + hh // 2, x + w // 2]:
        continue
    # a floating ember sits alone on dark stone: little glow in a ring around it
    x0, y0, x1, y1 = max(0, x - 14), max(0, y - 14), min(W, x + w + 14), min(H, y + hh + 14)
    comp = (lab[y0:y1, x0:x1] == i).astype(np.uint8)
    near = cv2.dilate(comp, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    ring = (cv2.dilate(comp, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (29, 29))) > 0) & (near == 0)
    if ring.sum() and glow[y0:y1, x0:x1][ring].mean() > 0.06:
        kept_crack += 1
        continue
    keep[lab == i] = 255
    removed += 1
print('kept as crack', kept_crack)
print('candidate components', n - 1, 'specks removed', removed)
# grow each speck to cover its glow halo, then fill from the surrounding stone
halo = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)))
out = cv2.inpaint(img, halo, 10, cv2.INPAINT_TELEA)
cv2.imwrite(dst, out, [cv2.IMWRITE_JPEG_QUALITY, 92])
# previews: the mask over the image, and before/after crops of an ember-rich corner and the ring
over = img.copy(); over[halo > 0] = (0, 255, 0)
cv2.imwrite(f'{prev}/mask-overlay.jpg', cv2.resize(over, (1376, 768)))
for name, (x, y, w, hh) in {'corner': (2150, 950, 600, 500), 'left': (0, 900, 600, 500), 'ring': (1050, 450, 700, 500)}.items():
    pair = np.hstack([img[y:y+hh, x:x+w], out[y:y+hh, x:x+w]])
    cv2.imwrite(f'{prev}/{name}-before-after.jpg', pair)
