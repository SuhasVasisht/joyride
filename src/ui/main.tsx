import { createRoot } from "react-dom/client";
import "./styles/base.css";
import "./styles/shell.css";
import { App } from "./App";

document.documentElement.dataset.theme = localStorage.getItem("joyride.theme") ?? "light";
createRoot(document.getElementById("root")!).render(<App />);
