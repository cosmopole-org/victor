// app/layout.jsx — the root layout, wrapping every page (like Next.js's
// app/layout). It renders a top app bar with navigation and a scrollable body.
import { Link, useRouter } from "../lib/router";

function NavBar() {
  var router = useRouter();
  return (
    <row gap={10}>
      <Link href="/" active={router.path == "/"}>
        Home
      </Link>
      <Link href="/counter" active={router.path == "/counter"}>
        Counter
      </Link>
      <Link href="/todos" active={router.path == "/todos"}>
        Todos
      </Link>
      <Link href="/scene" active={router.path == "/scene"}>
        3D
      </Link>
    </row>
  );
}

export default function RootLayout(props) {
  return (
    <column gap={0} grow={true}>
      <panel bg="surface" pad={20}>
        <column gap={12}>
          <heading>Victor × Next.js</heading>
          <caption>React on the Elpian VM, rendered by Godot</caption>
          <NavBar />
        </column>
      </panel>
      <scroll gap={20} pad={24}>
        {props.children}
      </scroll>
    </column>
  );
}
