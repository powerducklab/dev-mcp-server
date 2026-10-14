import messages from "./messages.json";
import React from "react";
import { createRoot } from "react-dom/client";
import { OasDocument } from "@powerduck/oas-document/react";
import "@powerduck/oas-document/react/index.css";
import "./style.css";
const language =
  Object.keys(messages).find(
    (key) => key.toLowerCase() === navigator.language.toLowerCase(),
  ) ||
  Object.keys(messages).find(
    (key) => key.split("-")[0] === navigator.language.split("-")[0],
  ) ||
  "en-US";
const [errorMessage, retryLabel] = messages[language];
document.documentElement.lang = language;
document.documentElement.dir = language.startsWith("ar") ? "rtl" : "ltr";
const root = createRoot(document.getElementById("root"));
fetch("./oas.json", { credentials: "omit" })
  .then((response) => {
    if (!response.ok) throw new Error("Document unavailable");
    return response.json();
  })
  .then((document) => {
    window.document.title = document.info?.title || "Powerduck API";
    root.render(
      <OasDocument
        input={document}
        style={{ minHeight: "100vh" }}
        header={{ showThemeToggle: true }}
      />,
    );
  })
  .catch(() => {
    root.render(
      <main style={{ padding: 32 }}>
        {errorMessage}{" "}
        <button onClick={() => window.location.reload()}>{retryLabel}</button>
      </main>,
    );
  });
