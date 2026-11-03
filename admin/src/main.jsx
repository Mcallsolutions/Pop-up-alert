import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { applyTheme, getStoredTheme } from "./services/theme";
import "./styles.css";

// Antes do primeiro render, para a tela de login ja abrir no tema escolhido.
applyTheme(getStoredTheme());

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

