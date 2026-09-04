import React, { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";

/**
 * AI-Powered Enterprise Document Analyzer & Automated Report Agent
 * -----------------------------------------------------------------
 * Frontend only. Talks to a stateless, database-free FastAPI backend:
 * POST /api/documents/upload returns { filename, character_count,
 * raw_text, summary } in one shot, and POST /api/documents/chat expects
 * { context, question } on every call — the backend keeps no record of
 * the document between requests, so this component holds `raw_text` in
 * local state and re-sends it as `context` alongside every question.
 * Swap API_BASE_URL for your deployed backend URL.
 */

const API_BASE_URL = "http://127.0.0.1:8000";
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// ---------------------------------------------------------------------------
// API layer — plain fetch, async/await, ready to wire to FastAPI
// ---------------------------------------------------------------------------

async function uploadDocument(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE_URL}/api/documents/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.detail || "Upload failed. Please try again.");
  }

  // Backend is stateless: it returns the full extracted text and an
  // AI-generated summary in one response. There is no documentId — the
  // frontend is responsible for holding onto `raw_text` and re-sending it
  // as `context` on every subsequent question.
  return response.json(); // { filename, character_count, raw_text, summary }
}

async function askDocumentQuestion(context, question) {
  const response = await fetch(`${API_BASE_URL}/api/documents/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The backend has no memory of the document between requests, so the
    // full document text is sent alongside every question as `context`.
    body: JSON.stringify({ context, question }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.detail || "The agent couldn't answer that. Try rephrasing.");
  }

  return response.json(); // { answer, question }
}

/**
 * The backend returns the summary as a single hyphen-bulleted string
 * (see services.py's prompt), not a structured array. Parse it into clean
 * bullet lines for the Executive Summary card.
 */
function parseSummaryBullets(rawSummary) {
  if (!rawSummary) return [];
  return rawSummary
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatusPill({ status }) {
  const copy = {
    idle: "Waiting for a document",
    uploading: "Uploading",
    processing: "Analyzing",
    completed: "Ready",
    error: "Something went wrong",
  };
  return (
    <div className={`status-pill status-pill--${status}`}>
      <span className="status-pill__dot" />
      {copy[status]}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="chat-bubble chat-bubble--agent chat-bubble--typing">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  // Upload / processing state
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | uploading | processing | completed | error
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [isDragActive, setIsDragActive] = useState(false);

  // The full extracted document text, held in local state and re-sent as
  // `context` on every chat request — this is what keeps the FastAPI
  // backend stateless and database-free.
  const [documentText, setDocumentText] = useState(null);

  // Summary state
  const [summary, setSummary] = useState(null); // { title, bullets }

  // Chat state
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isAgentTyping, setIsAgentTyping] = useState(false);

  const fileInputRef = useRef(null);
  const chatScrollRef = useRef(null);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isAgentTyping]);

  // ---- Validation -----------------------------------------------------

  const validateFile = (candidate) => {
    const isTxt =
      candidate.type === "text/plain" || candidate.name.toLowerCase().endsWith(".txt");
    if (!isTxt) {
      return "Only .txt files are supported right now.";
    }
    if (candidate.size > MAX_FILE_SIZE_BYTES) {
      return "That file is over the 5MB limit.";
    }
    return null;
  };

  // ---- Upload + processing pipeline -----------------------------------

  const runPipeline = useCallback(async (candidate) => {
    setErrorMessage("");
    setSummary(null);
    setMessages([]);
    setDocumentText(null);
    setStatus("uploading");
    setProgress(0);

    // Simulated progress ticks while the real request is in-flight. The
    // backend handles the chunked read + AI summarization inside a single
    // POST /api/documents/upload call (there's no separate "processing"
    // endpoint to poll), so we flip the visible status to "processing"
    // after a short delay to reflect that the server is now doing AI work
    // — the actual completion is still driven by the real fetch resolving.
    const progressTimer = setInterval(() => {
      setProgress((prev) => (prev < 90 ? prev + Math.random() * 12 : prev));
    }, 220);
    const processingTimer = setTimeout(() => setStatus("processing"), 900);

    try {
      const uploadResult = await uploadDocument(candidate);
      clearInterval(progressTimer);
      clearTimeout(processingTimer);
      setProgress(100);

      setDocumentText(uploadResult.raw_text);
      setSummary({
        title: uploadResult.filename,
        bullets: parseSummaryBullets(uploadResult.summary),
      });
      setStatus("completed");
      setMessages([
        {
          role: "agent",
          content: `I've read through "${uploadResult.filename}". Ask me anything about it.`,
        },
      ]);
    } catch (err) {
      clearInterval(progressTimer);
      clearTimeout(processingTimer);
      setStatus("error");
      setErrorMessage(err.message || "Unexpected error. Please try again.");
    }
  }, []);

  const handleFileChosen = (candidate) => {
    const validationError = validateFile(candidate);
    if (validationError) {
      setErrorMessage(validationError);
      setStatus("error");
      setFile(null);
      return;
    }
    setFile(candidate);
    runPipeline(candidate);
  };

  // ---- Drag & drop handlers --------------------------------------------

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFileChosen(dropped);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragActive(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragActive(false);
  };

  const handleInputChange = (e) => {
    const chosen = e.target.files?.[0];
    if (chosen) handleFileChosen(chosen);
  };

  const resetUpload = () => {
    setFile(null);
    setStatus("idle");
    setProgress(0);
    setErrorMessage("");
    setSummary(null);
    setMessages([]);
    setDocumentText(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ---- Chat --------------------------------------------------------------

  const handleSend = async () => {
    const question = chatInput.trim();
    if (!question || status !== "completed" || !documentText) return;

    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setChatInput("");
    setIsAgentTyping(true);

    try {
      // documentText (the raw_text captured from the upload response) is
      // sent as `context` on every call — the backend never stores it.
      const result = await askDocumentQuestion(documentText, question);
      setMessages((prev) => [...prev, { role: "agent", content: result.answer }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "agent", content: err.message || "I couldn't reach the server." },
      ]);
    } finally {
      setIsAgentTyping(false);
    }
  };

  const handleChatKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isChatDisabled = status !== "completed" || !documentText;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__mark">DA</span>
          <div className="topbar__title-group">
            <h1 className="topbar__title">Document Analyzer</h1>
            <p className="topbar__subtitle">Automated Report Agent</p>
          </div>
        </div>
        <StatusPill status={status} />
      </header>

      <main className="workspace">
        {/* -------------------------------------------------------- */}
        {/* Left column: upload + summary                            */}
        {/* -------------------------------------------------------- */}
        <section className="column column--main">
          <div className="panel upload-panel">
            <h2 className="panel__heading">Source document</h2>
            <p className="panel__description">
              Drop in a .txt file under 5MB. We'll extract the key points and open a
              line for follow-up questions.
            </p>

            <div
              className={
                "dropzone" +
                (isDragActive ? " dropzone--active" : "") +
                (status === "error" ? " dropzone--error" : "")
              }
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,text/plain"
                onChange={handleInputChange}
                className="dropzone__input"
              />

              {status === "idle" && (
                <div className="dropzone__content">
                  <svg
                    className="dropzone__icon"
                    viewBox="0 0 48 48"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M24 6v24m0 0-8-8m8 8 8-8"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M9 32v5a3 3 0 0 0 3 3h24a3 3 0 0 0 3-3v-5"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <p className="dropzone__title">Drag your document here</p>
                  <p className="dropzone__hint">or click to browse — .txt, up to 5MB</p>
                </div>
              )}

              {(status === "uploading" || status === "processing") && (
                <div className="dropzone__content">
                  <div className="spinner" aria-hidden="true" />
                  <p className="dropzone__title">
                    {status === "uploading" ? "Uploading" : "Analyzing document"}
                  </p>
                  <p className="dropzone__hint">{file?.name}</p>
                  {status === "uploading" && (
                    <div className="progress-track">
                      <div
                        className="progress-track__fill"
                        style={{ width: `${Math.min(progress, 100)}%` }}
                      />
                    </div>
                  )}
                  {status === "processing" && (
                    <div className="pulse-row" aria-hidden="true">
                      <span className="pulse-dot" />
                      <span className="pulse-dot" />
                      <span className="pulse-dot" />
                    </div>
                  )}
                </div>
              )}

              {status === "completed" && (
                <div className="dropzone__content">
                  <svg
                    className="dropzone__icon dropzone__icon--success"
                    viewBox="0 0 48 48"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2.4" />
                    <path
                      d="M16 24.5 21.5 30 33 18"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <p className="dropzone__title">{file?.name}</p>
                  <p className="dropzone__hint">Analysis complete</p>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      resetUpload();
                    }}
                  >
                    Upload a different file
                  </button>
                </div>
              )}

              {status === "error" && (
                <div className="dropzone__content">
                  <svg
                    className="dropzone__icon dropzone__icon--error"
                    viewBox="0 0 48 48"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2.4" />
                    <path
                      d="M24 15v13"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    />
                    <circle cx="24" cy="33" r="1.6" fill="currentColor" />
                  </svg>
                  <p className="dropzone__title">Upload failed</p>
                  <p className="dropzone__hint">{errorMessage}</p>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      resetUpload();
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="panel summary-panel">
            <h2 className="panel__heading">Executive summary</h2>

            {!summary && (
              <div className="empty-state">
                <p>
                  Your summary will appear here once a document has finished
                  processing.
                </p>
              </div>
            )}

            {summary && (
              <div className="summary-card">
                <p className="summary-card__eyebrow">{summary.title || file?.name}</p>
                <ul className="summary-card__list">
                  {summary.bullets?.map((point, index) => (
                    <li key={index} className="summary-card__item">
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        {/* -------------------------------------------------------- */}
        {/* Right column: persistent chat                            */}
        {/* -------------------------------------------------------- */}
        <section className="column column--chat">
          <div className="panel chat-panel">
            <div className="chat-panel__header">
              <h2 className="panel__heading">Ask the document</h2>
              <p className="panel__description">
                Questions are answered using only the uploaded file.
              </p>
            </div>

            <div className="chat-panel__messages" ref={chatScrollRef}>
              {messages.length === 0 && (
                <div className="empty-state empty-state--chat">
                  <p>Upload a document to start a conversation.</p>
                </div>
              )}

              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`chat-bubble chat-bubble--${
                    message.role === "user" ? "user" : "agent"
                  }`}
                >
                  {message.content}
                </div>
              ))}

              {isAgentTyping && <TypingIndicator />}
            </div>

            <div className="chat-panel__composer">
              <textarea
                className="chat-input"
                placeholder={
                  isChatDisabled
                    ? "Finish uploading a document to start chatting"
                    : "Ask a question about this document…"
                }
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleChatKeyDown}
                disabled={isChatDisabled}
                rows={1}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleSend}
                disabled={isChatDisabled || !chatInput.trim()}
              >
                Send
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}