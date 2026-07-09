// components/TodoList.jsx — useReducer for the list, useContext for a shared
// accent, and a keyed .map so the reconciler reuses rows across renders.
import { useReducer, useContext, useMemo, createContext } from "react";

// A context provided at the top of the list and read by every row.
export var AccentContext = createContext("primary");

function todoReducer(state, action) {
  if (action.type == "toggle") {
    var out = [];
    for (var i = 0; i < state.length; i++) {
      var it = state[i];
      if (it.id == action.id) {
        out.push({ id: it.id, label: it.label, done: !it.done });
      } else {
        out.push(it);
      }
    }
    return out;
  }
  return state;
}

function TodoRow(props) {
  var accent = useContext(AccentContext);
  return (
    <row gap={12}>
      <text grow={true} color={props.done ? "muted" : "text"}>
        {props.label}
      </text>
      <button
        kind={props.done ? "ghost" : "tonal"}
        onPress={function () {
          props.onToggle(props.id);
        }}
      >
        {props.done ? "Undo" : "Done"}
      </button>
    </row>
  );
}

export function TodoList() {
  var r = useReducer(todoReducer, [
    { id: 1, label: "Wire the reconciler", done: true },
    { id: 2, label: "Cover every hook", done: false },
    { id: 3, label: "Ship the template", done: false },
  ]);
  var todos = r[0];
  var dispatch = r[1];

  var remaining = useMemo(
    function () {
      var n = 0;
      for (var i = 0; i < todos.length; i++) {
        if (!todos[i].done) {
          n = n + 1;
        }
      }
      return n;
    },
    [todos]
  );

  var rows = todos.map(function (it) {
    return (
      <TodoRow
        key={"todo-" + it.id}
        id={it.id}
        label={it.label}
        done={it.done}
        onToggle={function (id) {
          dispatch({ type: "toggle", id: id });
        }}
      />
    );
  });

  return (
    <AccentContext.Provider value="accent">
      <card gap={14}>
        <caption>{remaining + " remaining"}</caption>
        <column gap={10}>{rows}</column>
      </card>
    </AccentContext.Provider>
  );
}
