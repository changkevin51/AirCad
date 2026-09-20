"""Green keycap detection adapted from the supplied test/tracker.js prototype.

The reference's coarse search and native-resolution crop follow the keycap
locally. OpenCV components replace the JS flood fill. Smoothing belongs in
display pixels in the browser, never twice on the same cursor.
"""
from dataclasses import dataclass, replace
import json
import math
from pathlib import Path

import numpy as np

MODEL_PATH = Path(__file__).with_name('keycap-model.json')
ACQUISITION_WINDOW_S = .3
LOCK_WINDOW_S = .3


@dataclass(frozen=True)
class Keycap:
    x: float
    y: float
    area: float
    box: tuple[float, float, float, float]
    confidence: float
    clipped: bool = False
    identity: int = 0


def calibrate_model(bgr):
    """The prototype's dominant-green histogram calibration, in HSV units 0–1."""
    import cv2
    pixels = bgr.reshape(-1, 3).astype(np.float32)
    hsv = cv2.cvtColor(bgr.astype(np.float32) / 255, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    hsv[:, 0] /= 360
    b, g, r = pixels.T
    keep = (g >= r * 1.06) & (g >= b * 1.1) & (hsv[:, 0] >= .18) & (hsv[:, 0] <= .44) & (hsv[:, 1] >= .3) & (hsv[:, 2] >= .22)
    samples = hsv[keep]
    if len(samples) < 20:
        return dict(hue=101 / 360, hueTolerance=.085, satMin=.26, valueMin=.14)
    bins = np.bincount((samples[:, 0] * 72).astype(int), minlength=72)
    dominant = (np.argmax(bins) + .5) / 72
    selected = samples[np.abs(samples[:, 0] - dominant) < .055]
    hue = float(selected[:, 0].mean())
    spread = float(np.abs(selected[:, 0] - hue).mean())
    return dict(hue=hue, hueTolerance=float(np.clip(spread * 3 + .045, .065, .1)),
                satMin=float(np.clip(selected[:, 1].mean() * .45, .2, .34)), valueMin=.14)


def compatible(a, b, looseness=1):
    distance = math.hypot(a.x - b.x, a.y - b.y)
    return distance <= max(40, max(a.box[2:]) * 1.65) * looseness and .4 <= b.area / max(1, a.area) <= 2.5


def detect_keycap(bgr, previous=None, tolerance=1.0, motion_scale=1.0, *, min_area=None, solid_center=True):
    """Return the best green convex target. No anatomy or learned model needed."""
    import cv2
    model = _MODEL
    height, width = bgr.shape[:2]
    hsv = cv2.cvtColor(bgr.astype(np.float32) / 255, cv2.COLOR_BGR2HSV)
    b, g, r = bgr.astype(np.float32).transpose(2, 0, 1)
    distance = np.abs(hsv[:, :, 0] / 360 - model['hue'])
    hue_tolerance = model['hueTolerance'] * tolerance
    mask = ((g >= r * 1.04) & (g >= b * 1.08) & (hsv[:, :, 1] >= model['satMin']) &
            (hsv[:, :, 2] >= model['valueMin']) & (distance <= hue_tolerance)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if min_area is None:
        min_area = max(12, width * height * .000025)
    best, best_score = None, -math.inf
    for label in range(1, count):
        x, y, w, h, area = stats[label]
        fill, aspect = area / (w * h), w / h
        if area < min_area or area > width * height * .85 or fill < .28 or not .25 <= aspect <= 4:
            continue
        # A clipped green background must not outscore an intact keycap and
        # then get rejected by the temporal tracker, hiding both targets.
        if x == 0 or y == 0 or x+w == width or y+h == height:
            continue
        component = (labels[y:y+h, x:x+w] == label).astype(np.uint8)
        weights = np.rint(255 * (1 - .45 * distance[y:y+h, x:x+w] / hue_tolerance))
        if solid_center:
            contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            moments = cv2.moments(cv2.convexHull(np.concatenate(contours)))
        else:
            moments = cv2.moments(np.where(component, weights, 0).astype(np.float32))
        if moments['m00'] <= 0:
            continue
        cx = x + .5 + moments['m10'] / moments['m00']
        cy = y + .5 + moments['m01'] / moments['m00']
        quality = float((1 - .45 * distance[y:y+h, x:x+w][component != 0] / hue_tolerance).mean())
        confidence = .25 * math.exp(-abs(math.log(aspect))) + .25 * min(1, fill * 1.25) + .3 * quality + .2 * min(1, math.sqrt(area / (min_area * 16)))
        candidate = Keycap(cx, cy, float(area), (int(x), int(y), int(w), int(h)), confidence)
        if confidence < .5 or (previous and not compatible(previous, candidate, motion_scale)):
            continue
        score = confidence
        if previous:
            reach = max(30, max(previous.box[2:]) * 2)
            score = confidence * .5 + math.exp(-math.hypot(cx - previous.x, cy - previous.y) / reach) * .35 + math.exp(-abs(math.log(area / max(1, previous.area)))) * .15
        if score > best_score:
            best_score = score
            best = candidate
    return best


def map_target(target, sx=1, sy=1, ox=0, oy=0):
    if target is None:
        return None
    x, y, w, h = target.box
    return replace(target, x=ox + target.x * sx, y=oy + target.y * sy,
                   area=target.area * sx * sy, box=(ox + x*sx, oy + y*sy, w*sx, h*sy))


def find_keycap(bgr, previous=None, tolerance=1.0, motion_scale=1.0):
    """Reference app.js pipeline: nearby detail first, coarse reacquisition second."""
    import cv2
    height, width = bgr.shape[:2]

    def refine(seed, padding):
        bx, by, bw, bh = seed.box
        x, y = max(0, math.floor(bx-padding)), max(0, math.floor(by-padding))
        right, bottom = min(width, math.ceil(bx+bw+padding)), min(height, math.ceil(by+bh+padding))
        if right-x < 2 or bottom-y < 2:
            return None
        detail = detect_keycap(
            bgr[y:bottom, x:right], map_target(seed, ox=-x, oy=-y), tolerance, motion_scale,
            min_area=max(12, width * height * .000025),
        )
        return map_target(detail, ox=x, oy=y)

    if previous is not None:
        padding = max(36, max(previous.box[2:]) * .8) * motion_scale
        nearby = refine(previous, padding)
        if nearby is not None:
            return nearby

    scale = min(1, 640 / max(width, height))
    sw, sh = max(1, round(width*scale)), max(1, round(height*scale))
    scan = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_LINEAR) if scale < 1 else bgr
    sx, sy = sw / width, sh / height
    coarse = detect_keycap(scan, map_target(previous, sx, sy), tolerance, motion_scale,
                           min_area=max(8, sw*sh*.0001), solid_center=False)
    if coarse is None:
        return None
    seed = map_target(coarse, 1/sx, 1/sy)
    return refine(seed, max(12, max(seed.box[2:]) * .25))


class KeycapTracker:
    """Missing frames have no measurement; nearby recovery retains target identity."""
    def __init__(self):
        self.raw = None
        self.pending = None
        self.last_seen = -math.inf
        self.last_update = -math.inf
        self.identity = 0
        self.visible = False

    def update(self, bgr, timestamp, tolerance=1.0):
        previous = self.raw if timestamp - self.last_seen <= LOCK_WINDOW_S else None
        return self.accept(find_keycap(bgr, previous, tolerance, self.motion_scale(timestamp)), timestamp)

    def motion_scale(self, timestamp):
        # The old fixed per-frame gate rejected ordinary motion when camera
        # frames arrived slowly (startup, exposure changes, or CPU contention).
        # Bound the expansion so a distant green distractor cannot take over.
        return min(2.5, max(1, (timestamp - self.last_seen) * 30))

    def accept(self, candidate, timestamp):
        if not math.isfinite(timestamp) or timestamp <= self.last_update:
            return None
        self.last_update = timestamp
        if timestamp - self.last_seen > LOCK_WINDOW_S:
            self.raw = None
        if candidate is None or candidate.clipped or candidate.confidence < .5:
            self.pending = None
            self.visible = False
            return None
        if self.raw and not compatible(self.raw, candidate, self.motion_scale(timestamp)):
            self.visible = False
            return None
        if self.raw is None:
            confirmed = self.pending and timestamp - self.pending[1] <= ACQUISITION_WINDOW_S and compatible(self.pending[0], candidate)
            self.pending = (candidate, timestamp)
            if not confirmed:
                self.visible = False
                return None
        if self.raw is None:
            self.identity += 1
        self.visible = True
        self.pending = None
        self.raw = candidate
        self.last_seen = timestamp
        return replace(candidate, identity=self.identity)


_MODEL = json.loads(MODEL_PATH.read_text()) if MODEL_PATH.exists() else dict(hue=101/360, hueTolerance=.085, satMin=.26, valueMin=.14)
