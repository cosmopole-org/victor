// app/page.jsx — the home route ("/"). An ordinary React component; every
// lowercase tag (<column>, <card>, <text> …) is a Victor widget, not HTML.
import { useRouter } from "../lib/router";

export default function Page() {
  var router = useRouter();
  return (
    <column gap={16}>
      <heading>Welcome</heading>
      <text wrap={true}>
        This screen is a Next.js-style React app — but its client does not run in
        a browser. It runs on the Victor engine: compiled by js2elpian, executed
        by the Elpian VM, and drawn by Godot with native Victor widgets.
      </text>
      <card gap={12}>
        <title>What is real here</title>
        <text wrap={true} color="muted">
          Function components, hooks, keys, context and effects are the genuine
          React programming model. The elements you write map to retained Godot
          Control nodes instead of DOM nodes.
        </text>
        <row gap={12}>
          <button
            onPress={function () {
              router.push("/counter");
            }}
          >
            Try the Counter
          </button>
          <button
            kind="tonal"
            onPress={function () {
              router.push("/todos");
            }}
          >
            Try the Todos
          </button>
        </row>
      </card>
    </column>
  );
}
