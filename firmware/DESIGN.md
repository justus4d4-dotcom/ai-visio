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

## Solve indicators

| State | Ring |
| --- | --- |
| Waiting / idle | Full, static grey track. |
| Analyzing / solving | Cyan center spinner. |
| Answer | The existing confidence ring remains the confidence indicator. |
| Error | Red error ring remains unchanged. |

## Source indicator

Show an icon-only source pill on the idle screen only. Hide it in solving,
answer, error, Case Study, Wi-Fi setup, OTA, settings, and connecting screens.

### Pill geometry and states

- Geometry: 30x20 px, 10 px radius, centered at `x=105`, `y=202`.
- Use primitive-drawn icons, not Unicode glyphs.
- Icons: native companion agent / desktop source, browser capture, or phone/ESP
  camera. Do not display source text.
- Active and available: cyan icon and outline.
- Selected but unavailable: orange icon and outline.
- Push source state through the ESP WebSocket initial state and whenever the
  selected source changes.

## Case Study mode

### Standard-screen entry

Idle and answer screens expose a compact cyan `Case Study` pill at
`x=74, y=26, w=92, h=28`. Its matching touch target is `x=68..172`,
`y=20..58`.

### Capture page

Case Study uses a compact outlined top tab to switch capture/solve pages and
a red `Exit & clear` button at the bottom. The middle of the circle contains
the camera action, status text, and screen count.

### Solve page

- Top tab label changes to `Go to Capture`.
- The middle region shows `Solve`, answer progress, or answer text.
- Lower red button remains `Exit & clear`.

## Existing firmware surfaces

Keep these two firmware files behaviorally equivalent:

- `firmware/src/main.cpp` (PlatformIO)
- `firmware/arduino/ai_visio_display/ai_visio_display.ino` (Arduino IDE)

When changing display behavior, implement and validate both surfaces.
