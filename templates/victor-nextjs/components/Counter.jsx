// components/Counter.jsx — a classic React counter. `print` (from the godot.js
// prelude) writes to the Godot console, so the effect's work is observable.
import { useState, useEffect, useRef } from "react";

export function Counter(props) {
  var s = useState(props.start || 0);
  var count = s[0];
  var setCount = s[1];

  // useRef persists across renders without causing one.
  var renders = useRef(0);
  renders.current = renders.current + 1;

  // useEffect runs after commit; the returned cleanup runs before the next
  // effect (and on unmount).
  useEffect(
    function () {
      print("[counter] committed value " + count);
      return function () {
        print("[counter] cleanup for " + count);
      };
    },
    [count]
  );

  return (
    <card gap={14}>
      <title>{"Value: " + count}</title>
      <caption>{"renders: " + renders.current}</caption>
      <row gap={12}>
        <button
          kind="outline"
          onPress={function () {
            setCount(count - 1);
          }}
        >
          -
        </button>
        <button
          onPress={function () {
            setCount(count + 1);
          }}
        >
          +
        </button>
        <button
          kind="ghost"
          onPress={function () {
            setCount(0);
          }}
        >
          Reset
        </button>
      </row>
    </card>
  );
}
