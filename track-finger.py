#!/usr/bin/env python3
"""Legacy launcher name for the green keycap OAK-D diagnostic preview.

Uses exactly the same detector and validated depth pipeline as AirCAD.
Space sets an origin, C clears it, Q exits. No hand/finger modes remain.
"""
from __future__ import annotations

import argparse
import math
from collections import deque
import cv2
import numpy as np
import base64
import threading
import time

from tracker.depth_camera import DepthCameraWorker, DepthConfig


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
    mode_label = "GREEN KEYCAP"
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



def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('keycap',), default='keycap')
    parser.parse_args(argv)

    lock = threading.Lock()
    latest = {"sample": None, "image": None, "status": "Starting green keycap tracker"}

    def sample(value):
        with lock:
            latest["sample"] = value

    def thumbnail(jpeg, width, height, revision=0):
        image = cv2.imdecode(np.frombuffer(base64.b64decode(jpeg), np.uint8), cv2.IMREAD_COLOR)
        with lock:
            latest["image"] = image

    def status(state, message, revision=0):
        with lock:
            latest["status"] = message
        print(message, flush=True)

    worker = DepthCameraWorker(DepthConfig(), sample, thumbnail, status)
    worker.start()
    origin = None
    trail = deque(maxlen=TRAIL_LEN)
    last_printed = None
    last_sample_time = None
    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
    try:
        while worker.is_alive():
            with lock:
                point, image, message = latest["sample"], latest["image"], latest["status"]
            xyz = None
            coordinates = 'No fresh keycap depth'
            if point is not None:
                message = 'Green keycap: ' + point.state
                if point.camera_mm is not None:
                    xyz = np.asarray(point.camera_mm) - (np.zeros(3) if origin is None else origin)
                    coordinates = 'X %.1f  Y %.1f  Z %.1f mm' % tuple(xyz)
                    if point.fresh and point.sample_time_ms != last_sample_time:
                        trail.append(xyz.copy())
                        last_sample_time = point.sample_time_ms
                        if last_printed is None or np.max(np.abs(xyz - last_printed)) >= 5:
                            print(coordinates, flush=True)
                            last_printed = xyz.copy()
                else:
                    trail.clear()
            frame = draw_scene(xyz, trail, origin)
            if image is not None:
                overlay_pip(frame, image)
            draw_hud(frame, message, coordinates, 'Space: set origin   C: clear origin   Q: exit', 'keycap')
            cv2.imshow(WINDOW_NAME, frame)
            key = cv2.waitKey(16) & 255
            if key in (ord('q'), ord('Q')):
                break
            if key == 32 and point is not None and point.fresh and point.sample_time_ms is not None and time.monotonic() * 1000 - point.sample_time_ms <= 200:
                origin = np.asarray(point.camera_mm)
                trail.clear()
                last_printed = None
            if key in (ord('c'), ord('C')):
                origin = None
                trail.clear()
                last_printed = None
    finally:
        worker.stop()
        worker.join(3)
        cv2.destroyAllWindows()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
