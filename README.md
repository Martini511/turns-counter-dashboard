# turns-counter-dashboard

Web Serial dashboard for the XENSIV™ turns counter. The same counter module
runs in two demos, and the page shows either one:

| Demo | Model | Shows |
|---|---|---|
| Door handle | `assets/models/Cardoor_handle_demo_v_3.glb` | handle travel, 0 – 67.31° |
| Steering wheel | `assets/models/Steering_wheel_demo_v_1.glb` | turns since zero, unlimited in both directions |

The models are plain CAD exports (Z up). The page rigs them itself when it
loads them: The parts that move, the shaft that carries the rotation axis and
the holder plate (`Add_on_holder_plate`) are named in `DEMOS` in `js/app.js`.

Both demos sit in the same holder plate. Before a board is connected the stage
shows only the empty holder; on connecting, the demo slides along the
dovetail rails into it, and slides out again on disconnecting or switching.

## Choosing the demo

Until the firmware reports its setup, a temporary switch in the header picks
the demo. Once the board sends one of these lines, its choice applies and the
switch is locked for that connection:

```
demo handle
demo wheel
```

`OK demo …` is accepted as well, as are `door`, `door_handle`, `steering` and
`steering_wheel`.