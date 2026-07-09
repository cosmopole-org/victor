// app/counter/page.jsx — the "/counter" route. Pages compose components exactly
// as in Next.js.
import { Counter } from "../../components/Counter";

export default function Page() {
  return (
    <column gap={16}>
      <heading>Counter</heading>
      <caption>useState + useEffect + useRef, committed to Godot nodes</caption>
      <Counter start={0} />
    </column>
  );
}
