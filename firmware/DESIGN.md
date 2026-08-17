# ESP Display Design Specification

This document is the implementation contract for the 240x240 round ESP display.
The editable visual reference is the **ESP Source Indicator - Design Sheet** in
the Vision-Design Figma file.

## Display fundamentals

- Target: 240x240 circular GC9A01 display.
- Background: black (`COL_BG`).
- Primary content: white (`COL_TEXT`).
- Secondary content and inactive status: grey (`COL_MUTED`).
- Primary action and active status: cyan (`COL_ACCENT`).
- Destructive action: red (`COL_BAD`).
- All content must stay inside the circular safe area. Do not place rectangular
  controls past the circular bezel and rely on clipping.
- Draw controls and labels centered on `CX` unless a design explicitly says
  otherwise.

## Outer status ring

The outer ring communicates solve state. It is not a confidence indicator.

| State | Ring |
| --- | --- |
| Waiting / idle | Full, static grey track. |
| Analyzing / solving | Same grey track plus one cyan arc segment that rotates clockwise. |
| Answer | The existing confidence ring remains the confidence indicator. |
| Error | Red error ring remains unchanged. |

### Analyzing animation

- Use the outer ring radius already used by idle (`CX - 6` to `CX - 2`).
- Draw a full grey track first.
- Draw one cyan segment of approximately 80 degrees on top.
- Advance the segment clockwise from elapsed time; the visual reference uses a
  continuous clockwise rotation.
- Keep animation rendering lightweight: calculate the start angle from
  `millis()` and redraw in the existing render loop. Do not allocate memory or
  introduce a timer task.
- The `Thinking` label is centered; the outer-ring animation replaces the
  previous small center spinner.

## Source indicator

Show a compact source pill only on standard solve screens:

- Idle
- Solving
- Answer
- Error

Hide it in Case Study, Wi-Fi setup, OTA, settings, and connecting screens.

### Pill geometry and states

- Geometry: 72x20 px, 10 px radius, centered at `x=84`, `y=202`.
- Use primitive-drawn icons, not Unicode glyphs.
- Label and icon:
  - `APP`: native companion agent / desktop source.
  - `WEB`: browser capture.
  - `CAM`: phone or ESP camera.
- Active and available: cyan icon, label, and outline.
- Selected but unavailable: orange icon, label, and outline.
- Disconnected or unknown: grey icon, label, and outline.
- Push source state through the ESP WebSocket initial state and whenever the
  selected source changes.

## Case Study mode

### Standard-screen entry

Idle and answer screens expose `CASE STUDY` as a large upper touch target,
not a small pill.

- The entire upper arc is actionable.
- Its cyan shape follows the circular bezel with symmetric stepped widths:
  - `x=64, y=0, w=112, h=12`
  - `x=40, y=12, w=160, h=16`
  - `x=26, y=28, w=188, h=24`
- Center the `CASE STUDY` label in the main section.
- Do not extend the target to the display's left/right edges where it would be
  cut off by the bezel.

### Capture page

Case Study capture uses three distinct vertical regions:

1. **Upper arc touch zone** - cyan, label `GO TO SOLVE`; changes to the
   Case Study solve page.
2. **Middle safe zone** - camera icon and `Tap to capture`; captures the
   scenario screen.
3. **Lower arc touch zone** - red, label `EXIT & CLEAR`; exits Case Study and
   clears captured scenario data.

The upper and lower arcs are intentionally large for robust touch
interpretation. Both use the same symmetric bezel-following dimensions:

| Region | Crown | Shoulder | Main |
| --- | --- | --- | --- |
| Upper | `64,0,112,12` | `40,12,160,16` | `26,28,188,24` |
| Lower | `64,228,112,12` | `40,212,160,16` | `26,188,188,24` |

Keep the camera action, status text, and screen count in the unobstructed
middle of the circle.

### Solve page

- Upper arc label changes to `GO TO CAPTURE`.
- The middle region shows `Solve`, answer progress, or answer text.
- Lower red arc remains `EXIT & CLEAR`.

## Existing firmware surfaces

Keep these two firmware files behaviorally equivalent:

- `firmware/src/main.cpp` (PlatformIO)
- `firmware/arduino/ai_visio_display/ai_visio_display.ino` (Arduino IDE)

When changing display behavior, implement and validate both surfaces.
