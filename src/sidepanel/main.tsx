import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const host = document.getElementById("root");
if (!host) throw new Error("side panel root element is missing");
createRoot(host).render(<App />);
