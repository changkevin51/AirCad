#!/usr/bin/env python3
"""Track an index fingertip or green LED on an OAK-D S2 and show its 3D position in mm."""

from __future__ import annotations

import argparse
import math
import sys
import time
from collections import deque
from pathlib import Path
from urllib.request import urlretrieve

import cv2
import depthai as dai
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision

INDEX_TIP = 8
INDEX_DIP = 7
INDEX_PIP = 6
FPS = 30
RGB_WIDTH = 1280
RGB_HEIGHT = 720
ROI_HALF_PX = 8
PRINT_DELTA_MM = 5.0
MIN_Z_MM = 100.0
MAX_Z_MM = 2000.0
MAX_DEPTH_SPREAD_MM = 80.0
MIN_DEPTH_PIXELS = 6
CONSENSUS_Z_MM = 45.0
SEARCH_Z_WINDOW_MM = 280.0
TRACK_Z_WINDOW_MM = 160.0
MAX_Z_STEP_MM = 70.0
Z_SLEW_MM = 35.0
Z_MEDIAN_LEN = 5
RELOCK_FRAMES = 5
RELOCK_CLUSTER_MM = 35.0
RELOCK_MIN_PIXEL_PX = 40.0
MAX_ROI_DELTA_PX = 70.0
ONEURO_MINCUTOFF = 1.0
ONEURO_BETA = 0.007
ONEURO_DCUTOFF = 1.0
HOLD_TIMEOUT_S = 0.45
NO_DEPTH_RELEASE_FRAMES = 10
NUM_DEPTH_ROIS = 3
DEFAULT_FX = 931.0
DEFAULT_FY = 931.0
SCENE_WIDTH = 1280
SCENE_HEIGHT = 720
VIEW_YAW_DEG = 38.0
VIEW_PITCH_DEG = 26.0
VIEW_DIST_MM = 2300.0
VIEW_FOV_DEG = 48.0
GRID_XY_MM = 400.0
GRID_Z_CAM_MM = 1500.0
GRID_STEP_MM = 100.0
AXIS_LEN_MM = 180.0
TRAIL_LEN = 80
PIP_WIDTH = 360
PIP_MARGIN = 18
WINDOW_NAME = "OAK-D 3D tracker"
HAND_MODEL_PATH = Path(__file__).with_name("hand_landmarker.task")
HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
)
LED_MIN_AREA = 12.0
LED_OFFSET_PX = 6.0
LED_HSV_LOW = np.array([40, 80, 80], dtype=np.uint8)
LED_HSV_HIGH = np.array([90, 255, 255], dtype=np.uint8)
LED_BGR_G_MIN = 160
LED_BGR_MARGIN = 40


def board_socket(new_name: str, old_name: str) -> dai.CameraBoardSocket:
    return getattr(dai.CameraBoardSocket, new_name, getattr(dai.CameraBoardSocket, old_name))


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def normalized_roi(nx: float, ny: float, frame_w: int, frame_h: int) -> dai.Rect:
    hx = ROI_HALF_PX / frame_w
    hy = ROI_HALF_PX / frame_h
    x1, y1 = clamp01(nx - hx), clamp01(ny - hy)
    x2, y2 = clamp01(nx + hx), clamp01(ny + hy)
    if x2 <= x1:
        x2 = min(1.0, x1 + 1.0 / frame_w)
    if y2 <= y1:
        y2 = min(1.0, y1 + 1.0 / frame_h)
    return dai.Rect(dai.Point2f(x1, y1), dai.Point2f(x2, y2))


def finger_sample_points(hand) -> list[tuple[float, float]]:
    tip, dip, pip = hand[INDEX_TIP], hand[INDEX_DIP], hand[INDEX_PIP]
    inward = (
        tip.x + (dip.x - tip.x) * 0.4,
        tip.y + (dip.y - tip.y) * 0.4,
    )
    return [inward, (dip.x, dip.y), (pip.x, pip.y)]


def led_sample_points(u: float, v: float, frame_w: int, frame_h: int) -> list[tuple[float, float]]:
    pts = [(u, v), (u - LED_OFFSET_PX, v), (u + LED_OFFSET_PX, v)]
    return [(clamp01(x / frame_w), clamp01(y / frame_h)) for x, y in pts]


def _largest_centroid(mask: np.ndarray, min_area: float) -> tuple[float, float] | None:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    best_area = min_area
    for contour in contours:
        area = cv2.contourArea(contour)
        if area > best_area:
            best_area = area
            best = contour
    if best is None:
        return None
    moments = cv2.moments(best)
    if moments["m00"] <= 1e-6:
        return None
    return moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]


def find_green_led(frame: np.ndarray) -> tuple[float, float] | None:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, LED_HSV_LOW, LED_HSV_HIGH)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    found = _largest_centroid(mask, LED_MIN_AREA)
    if found is not None:
        return found
    b_ch, g_ch, r_ch = cv2.split(frame)
    r16, g16, b16 = r_ch.astype(np.int16), g_ch.astype(np.int16), b_ch.astype(np.int16)
    bright = (g_ch >= LED_BGR_G_MIN) & (g16 > r16 + LED_BGR_MARGIN) & (g16 > b16 + LED_BGR_MARGIN)
    fallback = cv2.morphologyEx((bright.astype(np.uint8) * 255), cv2.MORPH_OPEN, kernel)
    return _largest_centroid(fallback, LED_MIN_AREA)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OAK-D S2 3D fingertip / green LED tracker")
    parser.add_argument("--mode", choices=("finger", "led"), default="finger")
    return parser.parse_args(argv)


def z_window(z_hint: float | None, locked: bool) -> tuple[float, float]:
    if z_hint is None:
        return MIN_Z_MM, MAX_Z_MM
    half = TRACK_Z_WINDOW_MM if locked else SEARCH_Z_WINDOW_MM
    return (
        max(MIN_Z_MM, z_hint - half),
        min(MAX_Z_MM, z_hint + half),
    )


def make_spatial_data(
    roi: dai.Rect,
    z_lo: float = MIN_Z_MM,
    z_hi: float = MAX_Z_MM,
) -> dai.SpatialLocationCalculatorConfigData:
    data = dai.SpatialLocationCalculatorConfigData()
    data.depthThresholds.lowerThreshold = int(z_lo)
    data.depthThresholds.upperThreshold = int(z_hi)
    data.roi = roi
    if hasattr(dai, "SpatialLocationCalculatorAlgorithm"):
        data.calculationAlgorithm = dai.SpatialLocationCalculatorAlgorithm.MEDIAN
    return data


def make_spatial_config(
    samples: list[tuple[float, float]],
    frame_w: int,
    frame_h: int,
    z_hint: float | None,
    locked: bool,
) -> dai.SpatialLocationCalculatorConfig:
    z_lo, z_hi = z_window(z_hint, locked)
    cfg = dai.SpatialLocationCalculatorConfig()
    for nx, ny in samples:
        cfg.addROI(make_spatial_data(normalized_roi(nx, ny, frame_w, frame_h), z_lo, z_hi))
    return cfg


def pixel_to_xyz(
    u: float,
    v: float,
    z: float,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> np.ndarray:
    return np.array([(u - cx) * z / fx, -(v - cy) * z / fy, z], dtype=np.float64)


def read_intrinsics(
    calib: object,
    rgb_socket: dai.CameraBoardSocket,
) -> tuple[float, float, float, float]:
    matrix = calib.getCameraIntrinsics(rgb_socket, RGB_WIDTH, RGB_HEIGHT)
    return float(matrix[0][0]), float(matrix[1][1]), float(matrix[0][2]), float(matrix[1][2])


def build_pipeline(rgb_socket: dai.CameraBoardSocket, lens_position: int) -> dai.Pipeline:
    pipeline = dai.Pipeline()

    cam_rgb = pipeline.create(dai.node.ColorCamera)
    left = pipeline.create(dai.node.MonoCamera)
    right = pipeline.create(dai.node.MonoCamera)
    stereo = pipeline.create(dai.node.StereoDepth)
    spatial = pipeline.create(dai.node.SpatialLocationCalculator)

    xout_rgb = pipeline.create(dai.node.XLinkOut)
    xout_spatial = pipeline.create(dai.node.XLinkOut)
    xin_spatial = pipeline.create(dai.node.XLinkIn)
    xout_rgb.setStreamName("rgb")
    xout_spatial.setStreamName("spatial")
    xin_spatial.setStreamName("spatial_config")

    cam_rgb.setBoardSocket(rgb_socket)
    cam_rgb.setResolution(dai.ColorCameraProperties.SensorResolution.THE_1080_P)
    cam_rgb.setIspScale(2, 3)  # 1920x1080 -> 1280x720
    cam_rgb.setFps(FPS)
    cam_rgb.setPreviewSize(RGB_WIDTH, RGB_HEIGHT)
    cam_rgb.setInterleaved(False)
    cam_rgb.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)
    if lens_position:
        cam_rgb.initialControl.setManualFocus(lens_position)

    left.setBoardSocket(board_socket("CAM_B", "LEFT"))
    right.setBoardSocket(board_socket("CAM_C", "RIGHT"))
    left.setResolution(dai.MonoCameraProperties.SensorResolution.THE_400_P)
    right.setResolution(dai.MonoCameraProperties.SensorResolution.THE_400_P)
    left.setFps(FPS)
    right.setFps(FPS)

    stereo.setDefaultProfilePreset(dai.node.StereoDepth.PresetMode.HIGH_DENSITY)
    stereo.setLeftRightCheck(True)
    stereo.setSubpixel(True)
    stereo.setDepthAlign(rgb_socket)
    stereo.setOutputSize(RGB_WIDTH, RGB_HEIGHT)
    if hasattr(stereo, "initialConfig") and hasattr(dai, "MedianFilter"):
        try:
            stereo.initialConfig.setMedianFilter(dai.MedianFilter.KERNEL_7x7)
        except Exception:
            pass

    if hasattr(spatial.inputConfig, "setWaitForMessage"):
        spatial.inputConfig.setWaitForMessage(False)
    elif hasattr(spatial, "setWaitForConfigInput"):
        spatial.setWaitForConfigInput(False)
    for _ in range(NUM_DEPTH_ROIS):
        spatial.initialConfig.addROI(
            make_spatial_data(dai.Rect(dai.Point2f(0.45, 0.45), dai.Point2f(0.55, 0.55)))
        )

    cam_rgb.isp.link(xout_rgb.input)
    left.out.link(stereo.left)
    right.out.link(stereo.right)
    stereo.depth.link(spatial.inputDepth)
    spatial.out.link(xout_spatial.input)
    xin_spatial.out.link(spatial.inputConfig)
    return pipeline


def format_xyz(x: float, y: float, z: float) -> str:
    return f"X: {x:7.1f}   Y: {y:7.1f}   Z: {z:7.1f} mm"


def spatial_roi_center_px(loc: object, frame_w: int, frame_h: int) -> tuple[float, float] | None:
    cfg = getattr(loc, "config", None)
    if cfg is None:
        return None
    roi = getattr(cfg, "roi", None)
    if roi is None:
        return None
    try:
        if hasattr(roi, "denormalize"):
            roi = roi.denormalize(frame_w, frame_h)
        if hasattr(roi, "topLeft") and hasattr(roi, "bottomRight"):
            tl, br = roi.topLeft(), roi.bottomRight()
            cx, cy = (tl.x + br.x) * 0.5, (tl.y + br.y) * 0.5
        else:
            x, y = float(roi.x), float(roi.y)
            w, h = float(roi.width), float(roi.height)
            cx, cy = x + w * 0.5, y + h * 0.5
        if 0.0 <= cx <= 1.0 and 0.0 <= cy <= 1.0:
            return cx * frame_w, cy * frame_h
        return cx, cy
    except Exception:
        return None


def roi_matches_point(loc: object, px: tuple[float, float], frame_w: int, frame_h: int) -> bool:
    center = spatial_roi_center_px(loc, frame_w, frame_h)
    if center is None:
        return True
    dx = center[0] - px[0]
    dy = center[1] - px[1]
    return (dx * dx + dy * dy) ** 0.5 <= MAX_ROI_DELTA_PX


def location_depth(loc: object) -> float | None:
    z = float(getattr(loc, "depthMedian", 0.0) or 0.0)
    if z <= 0.0:
        point = getattr(loc, "spatialCoordinates", None)
        if point is None:
            return None
        z = float(point.z)
    if not (MIN_Z_MM <= z <= MAX_Z_MM):
        return None
    depth_min = float(getattr(loc, "depthMin", z))
    depth_max = float(getattr(loc, "depthMax", z))
    if depth_min <= 0:
        depth_min = z
    if depth_max <= 0:
        depth_max = z
    if depth_max - depth_min > MAX_DEPTH_SPREAD_MM:
        if MIN_Z_MM <= depth_min <= MAX_Z_MM:
            return depth_min
        return None
    pixels = int(getattr(loc, "depthAveragePixelCount", MIN_DEPTH_PIXELS))
    if pixels < MIN_DEPTH_PIXELS:
        return None
    return z


def consensus_z(values: list[float]) -> float | None:
    if not values:
        return None
    if len(values) == 1:
        return float(values[0])
    zs = np.array(values, dtype=np.float64)
    z_near = float(np.min(zs))
    inliers = [z for z in values if abs(z - z_near) <= CONSENSUS_Z_MM]
    return float(np.mean(inliers))


class OneEuro:
    def __init__(
        self,
        mincutoff: float = ONEURO_MINCUTOFF,
        beta: float = ONEURO_BETA,
        dcutoff: float = ONEURO_DCUTOFF,
    ) -> None:
        self.mincutoff = mincutoff
        self.beta = beta
        self.dcutoff = dcutoff
        self._x: float | None = None
        self._dx: float = 0.0
        self._t: float | None = None

    def reset(self) -> None:
        self._x = None
        self._dx = 0.0
        self._t = None

    @staticmethod
    def _alpha(te: float, cutoff: float) -> float:
        tau = 1.0 / (2.0 * math.pi * max(cutoff, 1e-6))
        return 1.0 / (1.0 + tau / te)

    def apply(self, x: float, t: float) -> float:
        if self._x is None:
            self._x = x
            self._dx = 0.0
            self._t = t
            return x
        te = max(t - (self._t or t), 1e-3)
        dx = (x - self._x) / te
        a_d = self._alpha(te, self.dcutoff)
        dx_hat = a_d * dx + (1.0 - a_d) * self._dx
        cutoff = self.mincutoff + self.beta * abs(dx_hat)
        a = self._alpha(te, cutoff)
        x_hat = a * x + (1.0 - a) * self._x
        self._x = x_hat
        self._dx = dx_hat
        self._t = t
        return x_hat


def _pixel_dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


class CoordFilter:
    """Reject depth spikes, then One-Euro smooth camera-frame Z."""

    def __init__(self) -> None:
        self.euro = OneEuro()
        self.accepted: float | None = None
        self.output: float | None = None
        self.hint_z: float | None = None
        self.pending: list[float] = []
        self.z_buf: deque[float] = deque(maxlen=Z_MEDIAN_LEN)
        self.last_pixel: tuple[float, float] | None = None
        self.last_good_t = 0.0
        self.fresh = False
        self.relocked = False
        self.visible = False

    def z_hint(self) -> float | None:
        if self.accepted is not None:
            return self.accepted
        return self.hint_z

    def reset(self) -> None:
        self.euro.reset()
        self.accepted = None
        self.output = None
        self.hint_z = None
        self.pending = []
        self.z_buf.clear()
        self.last_pixel = None
        self.last_good_t = 0.0
        self.fresh = False
        self.relocked = False
        self.visible = False

    def _held(self) -> float | None:
        self.fresh = False
        self.relocked = False
        if not self.visible or self.output is None:
            return None
        return self.output

    def miss(self) -> float | None:
        held = self._held()
        if held is None:
            return None
        if time.monotonic() - self.last_good_t > HOLD_TIMEOUT_S:
            self.hint_z = None
            self.accepted = None
            self.output = None
            self.pending = []
            self.z_buf.clear()
            self.euro.reset()
            self.fresh = False
            self.relocked = False
            self.visible = False
            return None
        return held

    def clear_search(self) -> None:
        self.hint_z = None
        self.accepted = None
        self.pending = []
        self.z_buf.clear()

    def update(self, z: float, pixel: tuple[float, float]) -> float | None:
        now = time.monotonic()
        self.z_buf.append(float(z))
        z_med = float(np.median(self.z_buf))
        if self.accepted is None:
            return self._try_relock(z_med, pixel, now)
        if abs(z_med - self.accepted) > MAX_Z_STEP_MM:
            pixel_still = (
                self.last_pixel is not None
                and _pixel_dist(pixel, self.last_pixel) < RELOCK_MIN_PIXEL_PX
            )
            if pixel_still:
                self.pending = []
                return self._held()
            return self._try_relock(z_med, pixel, now)
        self.pending = []
        return self._accept(z_med, pixel, now, relocked=False)

    def _slew(self, z: float) -> float:
        if self.output is None:
            return z
        delta = z - self.output
        if abs(delta) <= Z_SLEW_MM:
            return z
        return self.output + math.copysign(Z_SLEW_MM, delta)

    def _accept(self, z: float, pixel: tuple[float, float], now: float, relocked: bool) -> float:
        self.accepted = z
        self.hint_z = z
        self.last_pixel = pixel
        slewed = self._slew(z)
        self.output = self.euro.apply(slewed, now)
        self.last_good_t = now
        self.fresh = True
        self.relocked = relocked
        self.visible = True
        return self.output

    def _try_relock(self, z: float, pixel: tuple[float, float], now: float) -> float | None:
        if self.pending and abs(z - self.pending[-1]) > RELOCK_CLUSTER_MM:
            self.pending = [z]
        else:
            self.pending.append(z)
        if len(self.pending) >= RELOCK_FRAMES:
            clustered = float(np.mean(self.pending))
            self.pending = []
            return self._accept(clustered, pixel, now, relocked=True)
        return self._held()


def look_at(eye: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    forward = target - eye
    norm = float(np.linalg.norm(forward))
    if norm < 1e-6:
        forward = np.array([0.0, 0.0, 1.0])
    else:
        forward = forward / norm
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(world_up, forward)
    right_norm = float(np.linalg.norm(right))
    if right_norm < 1e-6:
        right = np.array([1.0, 0.0, 0.0])
    else:
        right = right / right_norm
    up = np.cross(forward, right)
    return np.stack([right, up, forward], axis=0), eye


def view_camera(user_origin: bool) -> tuple[np.ndarray, np.ndarray, float]:
    yaw = math.radians(VIEW_YAW_DEG)
    pitch = math.radians(VIEW_PITCH_DEG)
    look = np.array([0.0, 40.0, 0.0 if user_origin else 520.0])
    offset = np.array(
        [
            math.sin(yaw) * math.cos(pitch),
            math.sin(pitch),
            -math.cos(yaw) * math.cos(pitch),
        ]
    ) * VIEW_DIST_MM
    eye = look + offset
    rotation, eye = look_at(eye, look)
    focal = (SCENE_WIDTH * 0.5) / math.tan(math.radians(VIEW_FOV_DEG) * 0.5)
    return rotation, eye, focal


def project_point(
    point: np.ndarray,
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
) -> tuple[int, int] | None:
    cam = rotation @ (np.asarray(point, dtype=np.float64) - eye)
    if cam[2] < 8.0:
        return None
    x = focal * cam[0] / cam[2] + SCENE_WIDTH * 0.5
    y = -focal * cam[1] / cam[2] + SCENE_HEIGHT * 0.5
    return int(round(x)), int(round(y))


def draw_line_3d(
    scene: np.ndarray,
    a: np.ndarray,
    b: np.ndarray,
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
    color: tuple[int, int, int],
    thickness: int = 1,
) -> None:
    pa = project_point(a, rotation, eye, focal)
    pb = project_point(b, rotation, eye, focal)
    if pa is None or pb is None:
        return
    cv2.line(scene, pa, pb, color, thickness, cv2.LINE_AA)


def draw_label_3d(
    scene: np.ndarray,
    point: np.ndarray,
    text: str,
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
    color: tuple[int, int, int],
    scale: float = 0.5,
) -> None:
    p = project_point(point, rotation, eye, focal)
    if p is None:
        return
    cv2.putText(scene, text, (p[0] + 6, p[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def draw_grid(
    scene: np.ndarray,
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
    user_origin: bool,
) -> None:
    z_min = -GRID_XY_MM if user_origin else 0.0
    z_max = GRID_XY_MM if user_origin else GRID_Z_CAM_MM
    color = (58, 56, 54)
    x = -GRID_XY_MM
    while x <= GRID_XY_MM + 0.1:
        draw_line_3d(
            scene,
            np.array([x, 0.0, z_min]),
            np.array([x, 0.0, z_max]),
            rotation,
            eye,
            focal,
            color,
        )
        x += GRID_STEP_MM
    z = z_min
    while z <= z_max + 0.1:
        draw_line_3d(
            scene,
            np.array([-GRID_XY_MM, 0.0, z]),
            np.array([GRID_XY_MM, 0.0, z]),
            rotation,
            eye,
            focal,
            color,
        )
        z += GRID_STEP_MM
    draw_label_3d(
        scene,
        np.array([GRID_STEP_MM, 0.0, z_min if user_origin else GRID_STEP_MM]),
        "100 mm",
        rotation,
        eye,
        focal,
        (120, 118, 116),
        0.4,
    )


def draw_axes(scene: np.ndarray, rotation: np.ndarray, eye: np.ndarray, focal: float) -> None:
    origin = np.zeros(3)
    axes = (
        (np.array([AXIS_LEN_MM, 0.0, 0.0]), (70, 70, 230), "X"),
        (np.array([0.0, AXIS_LEN_MM, 0.0]), (80, 200, 90), "Y"),
        (np.array([0.0, 0.0, AXIS_LEN_MM]), (230, 170, 70), "Z"),
    )
    for vec, color, name in axes:
        draw_line_3d(scene, origin, vec, rotation, eye, focal, color, 2)
        draw_label_3d(scene, vec, name, rotation, eye, focal, color, 0.6)


def draw_camera_gizmo(
    scene: np.ndarray,
    camera_xyz: np.ndarray,
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
) -> None:
    origin = np.asarray(camera_xyz, dtype=np.float64)
    depth = 70.0
    half_w, half_h = 36.0, 22.0
    corners = [
        origin + np.array([-half_w, -half_h, depth]),
        origin + np.array([half_w, -half_h, depth]),
        origin + np.array([half_w, half_h, depth]),
        origin + np.array([-half_w, half_h, depth]),
    ]
    color = (170, 170, 170)
    for corner in corners:
        draw_line_3d(scene, origin, corner, rotation, eye, focal, color, 1)
    for i, corner in enumerate(corners):
        draw_line_3d(scene, corner, corners[(i + 1) % 4], rotation, eye, focal, color, 1)
    draw_label_3d(scene, origin, "cam", rotation, eye, focal, (180, 180, 180), 0.4)


def draw_trail(
    scene: np.ndarray,
    trail: deque[np.ndarray],
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
) -> None:
    if len(trail) < 2:
        return
    n = len(trail)
    for i in range(1, n):
        t = i / max(n - 1, 1)
        color = (int(40 + 40 * t), int(90 + 110 * t), int(110 + 145 * t))
        draw_line_3d(scene, trail[i - 1], trail[i], rotation, eye, focal, color, 2)


def draw_marker(
    scene: np.ndarray,
    point: np.ndarray,
    rotation: np.ndarray,
    eye: np.ndarray,
    focal: float,
) -> None:
    foot = np.array([point[0], 0.0, point[2]])
    draw_line_3d(scene, point, foot, rotation, eye, focal, (90, 160, 180), 1)
    p = project_point(point, rotation, eye, focal)
    f = project_point(foot, rotation, eye, focal)
    if f is not None:
        cv2.circle(scene, f, 4, (70, 120, 130), 1, cv2.LINE_AA)
    if p is not None:
        cv2.circle(scene, p, 9, (80, 220, 255), -1, cv2.LINE_AA)
        cv2.circle(scene, p, 12, (255, 255, 255), 1, cv2.LINE_AA)


def overlay_pip(scene: np.ndarray, frame: np.ndarray) -> None:
    pip_h = max(1, int(PIP_WIDTH * frame.shape[0] / frame.shape[1]))
    pip = cv2.resize(frame, (PIP_WIDTH, pip_h), interpolation=cv2.INTER_AREA)
    x0 = scene.shape[1] - PIP_WIDTH - PIP_MARGIN
    y0 = scene.shape[0] - pip_h - PIP_MARGIN
    if x0 < 0 or y0 < 0:
        return
    scene[y0 : y0 + pip_h, x0 : x0 + PIP_WIDTH] = pip
    cv2.rectangle(scene, (x0 - 1, y0 - 1), (x0 + PIP_WIDTH, y0 + pip_h), (190, 190, 190), 1)


def draw_scene(
    xyz: np.ndarray | None,
    trail: deque[np.ndarray],
    origin: np.ndarray | None,
) -> np.ndarray:
    scene = np.full((SCENE_HEIGHT, SCENE_WIDTH, 3), 28, dtype=np.uint8)
    scene[:] = (32, 28, 26)
    user_origin = origin is not None
    rotation, eye, focal = view_camera(user_origin)
    draw_grid(scene, rotation, eye, focal, user_origin)
    draw_axes(scene, rotation, eye, focal)
    camera_xyz = np.zeros(3) if origin is None else -origin
    draw_camera_gizmo(scene, camera_xyz, rotation, eye, focal)
    draw_trail(scene, trail, rotation, eye, focal)
    if xyz is not None:
        draw_marker(scene, xyz, rotation, eye, focal)
    return scene


def draw_hud(
    frame: np.ndarray,
    status: str,
    coord_text: str,
    origin_text: str,
    mode: str,
) -> None:
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (frame.shape[1], 110), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.45, frame, 0.55, 0, frame)
    mode_label = "LED" if mode == "led" else "FINGER"
    cv2.putText(
        frame,
        f"[{mode_label}]  {status}",
        (16, 32),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )
    cv2.putText(frame, coord_text, (16, 64), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (80, 220, 255), 2, cv2.LINE_AA)
    cv2.putText(frame, origin_text, (16, 96), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1, cv2.LINE_AA)


def open_device() -> dai.Device:
    try:
        return dai.Device()
    except Exception as exc:
        print("Could not open an OAK camera.")
        print("Plug the OAK-D S2 into a USB3 port and try again.")
        print(f"({exc})")
        raise SystemExit(1) from exc


def ensure_hand_model() -> Path:
    if not HAND_MODEL_PATH.exists():
        print(f"Downloading hand landmarker model to {HAND_MODEL_PATH.name}...")
        urlretrieve(HAND_MODEL_URL, HAND_MODEL_PATH)
    return HAND_MODEL_PATH


def make_hand_landmarker() -> vision.HandLandmarker:
    options = vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(ensure_hand_model())),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.65,
        min_tracking_confidence=0.6,
    )
    return vision.HandLandmarker.create_from_options(options)


def pick_spatial_sample(
    spatial_packets: list,
    sample_px: list[tuple[float, float]],
    frame_w: int,
    frame_h: int,
) -> float | None:
    if not sample_px:
        return None
    for packet in reversed(spatial_packets):
        locations = packet.getSpatialLocations()
        if not locations:
            continue
        matched: list[float] = []
        fallback: list[float] = []
        for loc, px in zip(locations, sample_px):
            z = location_depth(loc)
            if z is None:
                continue
            fallback.append(z)
            if roi_matches_point(loc, px, frame_w, frame_h):
                matched.append(z)
        if len(locations) > len(sample_px):
            for loc in locations[len(sample_px) :]:
                z = location_depth(loc)
                if z is not None:
                    fallback.append(z)
        if matched:
            return consensus_z(matched)
        if fallback:
            return consensus_z(fallback)
    return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    mode = args.mode
    rgb_socket = board_socket("CAM_A", "RGB")

    with open_device() as device:
        lens_position = 0
        fx, fy, cx, cy = DEFAULT_FX, DEFAULT_FY, RGB_WIDTH * 0.5, RGB_HEIGHT * 0.5
        try:
            calib = device.readCalibration2()
            lens_position = calib.getLensPosition(rgb_socket) or 0
            fx, fy, cx, cy = read_intrinsics(calib, rgb_socket)
        except Exception as exc:
            print(f"Warning: could not read calibration ({exc}). Using fallback intrinsics.")

        device.startPipeline(build_pipeline(rgb_socket, lens_position))
        rgb_queue = device.getOutputQueue("rgb", maxSize=4, blocking=True)
        spatial_queue = device.getOutputQueue("spatial", maxSize=4, blocking=False)
        config_queue = device.getInputQueue("spatial_config")

        hands = make_hand_landmarker()
        coord_filter = CoordFilter()
        trail: deque[np.ndarray] = deque(maxlen=TRAIL_LEN)
        origin = None
        last_printed = None
        last_timestamp_ms = -1
        no_depth_streak = 0

        print("OAK-D S2 3D tracker")
        print("Camera origin is the RGB lens center. +X right, +Y up, +Z forward (mm).")
        print("F      finger tracking")
        print("L      green LED tracking")
        print("SPACE  set (0,0,0) at the current target")
        print("C      clear origin (back to camera frame)")
        print("Q      quit")
        print(f"Mode: {mode}")
        if lens_position:
            print(f"RGB focus locked to factory calibration ({lens_position}).")

        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)

        try:
            while True:
                rgb_in = rgb_queue.get()
                spatial_packets = spatial_queue.tryGetAll()
                frame = rgb_in.getCvFrame()
                height, width = frame.shape[:2]
                rgb = np.ascontiguousarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                timestamp_ms = int(time.monotonic() * 1000)
                if timestamp_ms <= last_timestamp_ms:
                    timestamp_ms = last_timestamp_ms + 1
                last_timestamp_ms = timestamp_ms

                status = "No LED" if mode == "led" else "No hand"
                coord_text = "X:     ---   Y:     ---   Z:     --- mm"
                xyz = None
                cam_xyz = None
                tip_px = None
                samples: list[tuple[float, float]] = []
                applied = False
                have_target = False

                if mode == "finger":
                    result = hands.detect_for_video(
                        mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb),
                        timestamp_ms,
                    )
                    if result.hand_landmarks:
                        hand = result.hand_landmarks[0]
                        vision.drawing_utils.draw_landmarks(
                            frame,
                            hand,
                            vision.HandLandmarksConnections.HAND_CONNECTIONS,
                            vision.drawing_styles.get_default_hand_landmarks_style(),
                            vision.drawing_styles.get_default_hand_connections_style(),
                        )
                        tip = hand[INDEX_TIP]
                        tip_px = (int(tip.x * width), int(tip.y * height))
                        samples = finger_sample_points(hand)
                        have_target = True
                else:
                    led = find_green_led(frame)
                    if led is not None:
                        tip_px = (int(round(led[0])), int(round(led[1])))
                        samples = led_sample_points(led[0], led[1], width, height)
                        have_target = True

                if have_target and tip_px is not None:
                    sample_px = [(nx * width, ny * height) for nx, ny in samples]
                    config_queue.send(
                        make_spatial_config(
                            samples,
                            width,
                            height,
                            coord_filter.z_hint(),
                            coord_filter.accepted is not None,
                        )
                    )

                    measured_z = pick_spatial_sample(spatial_packets, sample_px, width, height)
                    if measured_z is not None:
                        no_depth_streak = 0
                        filtered_z = coord_filter.update(
                            measured_z, (float(tip_px[0]), float(tip_px[1]))
                        )
                        applied = True
                        if filtered_z is None or not coord_filter.visible:
                            status = "Locking onto LED" if mode == "led" else "Locking onto fingertip"
                        else:
                            cam_xyz = pixel_to_xyz(
                                float(tip_px[0]),
                                float(tip_px[1]),
                                filtered_z,
                                fx,
                                fy,
                                cx,
                                cy,
                            )
                    elif not spatial_packets:
                        status = "Waiting for depth"
                    else:
                        no_depth_streak += 1
                        if no_depth_streak >= NO_DEPTH_RELEASE_FRAMES:
                            coord_filter.clear_search()
                        status = "No depth at LED" if mode == "led" else "No depth at fingertip"

                    color = (80, 220, 255) if cam_xyz is not None else (0, 180, 255)
                    cv2.circle(frame, tip_px, 10, color, 2, cv2.LINE_AA)
                    for nx, ny in samples:
                        sx, sy = int(nx * width), int(ny * height)
                        x1 = max(0, sx - ROI_HALF_PX)
                        y1 = max(0, sy - ROI_HALF_PX)
                        x2 = min(width - 1, sx + ROI_HALF_PX)
                        y2 = min(height - 1, sy + ROI_HALF_PX)
                        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 1)

                if not applied:
                    held_z = coord_filter.miss()
                    if held_z is not None and tip_px is not None and coord_filter.visible:
                        cam_xyz = pixel_to_xyz(
                            float(tip_px[0]),
                            float(tip_px[1]),
                            held_z,
                            fx,
                            fy,
                            cx,
                            cy,
                        )

                if not coord_filter.visible:
                    trail.clear()

                if cam_xyz is not None:
                    xyz = cam_xyz if origin is None else cam_xyz - origin
                    if have_target:
                        status = "Tracking green LED" if mode == "led" else "Tracking index fingertip"
                    coord_text = format_xyz(*xyz)
                    trail.append(xyz.copy())
                    if last_printed is None or np.max(np.abs(xyz - last_printed)) >= PRINT_DELTA_MM:
                        frame_name = "user origin" if origin is not None else "camera origin"
                        print(f"{format_xyz(*xyz)}   ({frame_name})")
                        last_printed = xyz.copy()
                else:
                    trail.clear()

                if origin is None:
                    origin_text = "Origin: camera (RGB lens). SPACE sets 0,0,0 at the current target. F/L switch mode."
                else:
                    origin_text = (
                        f"Origin: target at camera "
                        f"{origin[0]:.0f}, {origin[1]:.0f}, {origin[2]:.0f} mm. C clears. F/L switch mode."
                    )

                scene = draw_scene(xyz, trail, origin)
                overlay_pip(scene, frame)
                draw_hud(scene, status, coord_text, origin_text, mode)
                cv2.imshow(WINDOW_NAME, scene)

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ord("Q")):
                    break
                if key == ord(" ") and cam_xyz is not None:
                    origin = cam_xyz.copy()
                    last_printed = None
                    trail.clear()
                    print(f"Origin set to camera {origin[0]:.1f}, {origin[1]:.1f}, {origin[2]:.1f} mm")
                if key in (ord("c"), ord("C")):
                    origin = None
                    last_printed = None
                    trail.clear()
                    print("Origin cleared. Coordinates are camera-frame again.")
                if key in (ord("f"), ord("F"), ord("l"), ord("L")):
                    new_mode = "led" if key in (ord("l"), ord("L")) else "finger"
                    if new_mode != mode:
                        mode = new_mode
                        coord_filter.reset()
                        trail.clear()
                        last_printed = None
                        no_depth_streak = 0
                        print(f"Mode: {mode}")
        finally:
            hands.close()
            cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    sys.exit(main())
