// app/todos/page.jsx — the "/todos" route.
import { TodoList } from "../../components/TodoList";

export default function Page() {
  return (
    <column gap={16}>
      <heading>Todos</heading>
      <caption>useReducer + useContext + a keyed list</caption>
      <TodoList />
    </column>
  );
}
