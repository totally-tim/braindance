  // The sprite grows into its cell as the master rises, so one character stands for one cube
  // of room. The glyph branch's ceiling is 255 reference pixels scaled by k and held under
  // the hardware's, so the range at which the tiling opens does not move with output size.
  // The else branch keeps its literal 64: export-check's pointsize-absolute anchors on it.
  if (glyph > 0.0) {
    float base = clamp(pointSize * zoom * k / dist, 1.0, 64.0);
    gl_PointSize = clamp(mix(base, cellPx * k * zoom, glyph), 1.0, min(255.0 * k, pointCeiling));
  } else {
    gl_PointSize = clamp(pointSize * zoom * k / max(0.15, -mv.z), 1.0, 64.0);
  }
