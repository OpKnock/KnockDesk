import { createRoot } from "react-dom/client";
import KnockDeskApp from "./KnockDeskApp";
import "./desktop.css";

const root = document.getElementById("root");
if (!root) throw new Error("KnockDesk renderer root element is missing");

createRoot(root).render(<KnockDeskApp />);
