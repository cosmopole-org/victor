// app/scene/page.jsx — the "/scene" route: a MIXED 2D + 3D screen.
//
// <scene3d> is the 2D↔3D bridge (a SubViewportContainer + SubViewport). Inside
// it live ordinary Node3D host elements — an environment, a light, a camera, a
// floor and the rotating cubes. Outside it, plain 2D React controls drive the
// 3D world through useState: the slider sets spin speed, the buttons add/remove
// cubes. Nothing here is special-cased — 2D and 3D compose in one React tree.
import { useState } from "react";
import { Spinner3D } from "../../components/Spinner3D";

function World(props) {
  return (
    <scene3d height={480}>
      <environment
        bg={new Color(0.03, 0.04, 0.07, 1.0)}
        ambient={new Color(0.5, 0.6, 0.85, 1.0)}
        ambientEnergy={0.7}
      />
      <directionallight rotation={[-50, -30, 0]} energy={1.2} color={new Color(1.0, 0.97, 0.9, 1.0)} />
      <camera3d position={[0.0, 3.0, 8.0]} rotation={[-18, 0, 0]} fov={55} />
      <plane3d width={18} depth={18} color={new Color(0.12, 0.13, 0.18, 1.0)} roughness={1.0} />
      <Spinner3D count={props.count} speed={props.speed} />
    </scene3d>
  );
}

export default function Page() {
  var s = useState(30.0);
  var speed = s[0];
  var setSpeed = s[1];
  var c = useState(3);
  var count = c[0];
  var setCount = c[1];

  return (
    <column gap={16}>
      <heading>2D + 3D</heading>
      <caption>a live Godot 3D scene embedded in the React UI</caption>

      <World count={count} speed={speed} />

      <card gap={14}>
        <row gap={12}>
          <text grow={true}>Spin speed</text>
          <text color="primary">{"" + round(speed) + " deg/s"}</text>
        </row>
        <slider
          min={0.0}
          max={180.0}
          value={speed}
          onChange={function (v) {
            setSpeed(v);
          }}
        />
        <row gap={12}>
          <text grow={true}>{"Cubes: " + count}</text>
          <button
            kind="outline"
            onPress={function () {
              if (count > 1) {
                setCount(count - 1);
              }
            }}
          >
            -
          </button>
          <button
            onPress={function () {
              if (count < 8) {
                setCount(count + 1);
              }
            }}
          >
            +
          </button>
        </row>
      </card>
    </column>
  );
}
