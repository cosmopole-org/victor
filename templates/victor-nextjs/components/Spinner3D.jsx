// components/Spinner3D.jsx — a rotating group of 3D cubes. Shows the
// react-three-fiber idiom on Victor: useFrame(delta) animates the node through
// its ref every frame, while the cubes are described declaratively with keys so
// adding/removing them reconciles into the live 3D scene.
import { useRef, useFrame } from "react";

function Cube(props) {
  return (
    <box
      size={[0.8, 0.8, 0.8]}
      color={props.color}
      emission={props.color}
      emissionEnergy={0.35}
      roughness={0.4}
      metallic={0.1}
      position={[props.x, 0.6, 0.0]}
    />
  );
}

export function Spinner3D(props) {
  var ref = useRef(null);
  var angle = useRef(0.0);

  useFrame(function (d) {
    if (ref.current != null) {
      angle.current = angle.current + d * props.speed;
      ref.current.set("rotation_degrees", new Vector3(0.0, angle.current, 0.0));
    }
  });

  var cubes = [];
  var n = props.count;
  for (var i = 0; i < n; i++) {
    var x = (i - (n - 1) * 0.5) * 1.15;
    var hue = n > 1 ? i / (n - 1) : 0.0;
    var col = new Color(0.35 + 0.6 * hue, 0.55, 1.0 - 0.6 * hue, 1.0);
    cubes.push(<Cube key={"cube-" + i} x={x} color={col} />);
  }

  return <node3d ref={ref}>{cubes}</node3d>;
}
