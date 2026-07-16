// react_3d_demo.js — a MIXED 2D + 3D Victor app written in React, shown in the
// compiled (_jsx) form the toolchain emits. A live Godot 3D scene (camera,
// light, floor, a rotating ring of cubes) is embedded inside an ordinary 2D
// React UI, and 2D controls drive the 3D world through React state:
//
//   * <scene3d> is the 2D<->3D bridge (SubViewportContainer + SubViewport).
//   * <environment>/<directionallight>/<camera3d>/<plane3d>/<box> are Node3D
//     host elements created via the G3 layer in godot.js.
//   * useFrame(delta) animates the spinner imperatively through its ref.
//   * a 2D <slider> sets spin speed and 2D <button>s add/remove cubes — all
//     plain useState.
//
// The authored (JSX) version lives in templates/victor-nextjs/app/scene/.
import 'godot.js';
import 'ui.js';
import 'react.js';

function Cube(props) {
  return _jsx("box", {
    size: [0.8, 0.8, 0.8],
    color: props.color,
    emission: props.color,
    emissionEnergy: 0.35,
    roughness: 0.4,
    metallic: 0.1,
    position: [props.x, 0.6, 0.0],
  });
}

function Spinner(props) {
  let ref = useRef(null);
  let angle = useRef(0.0);
  useFrame((d) => {
    if (ref.current != null) {
      angle.current = angle.current + d * props.speed;
      ref.current.set("rotation_degrees", new Vector3(0.0, angle.current, 0.0));
    }
  });

  let cubes = [];
  let n = props.count;
  for (let i = 0; i < n; i++) {
    let x = (i - (n - 1) * 0.5) * 1.15;
    let hue = n > 1 ? i / (n - 1) : 0.0;
    let col = new Color(0.35 + 0.6 * hue, 0.55, 1.0 - 0.6 * hue, 1.0);
    cubes.push(_jsx(Cube, { x: x, color: col }, "cube-" + i));
  }
  return _jsx("node3d", { ref: ref, children: cubes });
}

function World(props) {
  return _jsxs("scene3d", {
    height: 520,
    children: [
      _jsx("environment", {
        bg: new Color(0.03, 0.04, 0.07, 1.0),
        ambient: new Color(0.5, 0.6, 0.85, 1.0),
        ambientEnergy: 0.7,
      }),
      _jsx("directionallight", {
        rotation: [-50, -30, 0],
        energy: 1.2,
        color: new Color(1.0, 0.97, 0.9, 1.0),
      }),
      _jsx("camera3d", { position: [0.0, 3.0, 8.0], rotation: [-18, 0, 0], fov: 55 }),
      _jsx("plane3d", {
        width: 18,
        depth: 18,
        color: new Color(0.12, 0.13, 0.18, 1.0),
        roughness: 1.0,
        position: [0.0, 0.0, 0.0],
      }),
      _jsx(Spinner, { count: props.count, speed: props.speed }),
    ],
  });
}

function App() {
  let s = useState(30.0);
  let speed = s[0];
  let setSpeed = s[1];
  let c = useState(3);
  let count = c[0];
  let setCount = c[1];

  return _jsxs("column", {
    gap: 0,
    grow: true,
    children: [
      _jsx("panel", {
        bg: "surface",
        pad: 20,
        children: _jsxs("column", {
          gap: 8,
          children: [
            _jsx("heading", { children: "Victor 2D + 3D" }),
            _jsx("caption", { children: "React driving a Godot 3D scene inside a 2D UI" }),
          ],
        }),
      }),
      _jsxs("column", {
        gap: 16,
        pad: 20,
        grow: true,
        children: [
          _jsx(World, { count: count, speed: speed }),
          _jsx("card", {
            gap: 14,
            children: _jsxs("column", {
              gap: 14,
              children: [
                _jsxs("row", {
                  gap: 12,
                  children: [
                    _jsx("text", { grow: true, children: "Spin speed" }),
                    _jsx("text", { color: "primary", children: "" + round(speed) + " deg/s" }),
                  ],
                }),
                _jsx("slider", {
                  min: 0.0,
                  max: 180.0,
                  value: speed,
                  onChange: (v) => {
                    setSpeed(v);
                  },
                }),
                _jsxs("row", {
                  gap: 12,
                  children: [
                    _jsx("text", { grow: true, children: "Cubes: " + count }),
                    _jsx("button", {
                      kind: "outline",
                      onPress: () => {
                        if (count > 1) {
                          setCount(count - 1);
                        }
                      },
                      children: "-",
                    }),
                    _jsx("button", {
                      onPress: () => {
                        if (count < 8) {
                          setCount(count + 1);
                        }
                      },
                      children: "+",
                    }),
                  ],
                }),
              ],
            }),
          }),
        ],
      }),
    ],
  });
}

VictorClient.mountApp(_jsx(App, {}), { design: [720, 1280], portrait: true, theme: "dark" });
