import asyncio
from typing import AsyncGenerator

from google import genai
from fastapi import HTTPException, UploadFile, status

from config import settings


_client = genai.Client(api_key=settings.GEMINI_API_KEY)

# Strict RAG system instruction: the model is only ever allowed to answer
# from the supplied document context. This is what stops the AI from
# hallucinating an answer using outside knowledge.
_RAG_SYSTEM_INSTRUCTION = (
    "You are a document analysis assistant. You must answer strictly and "
    "only using the CONTEXT provided below. Do not use outside knowledge, "
    "assumptions, or general world knowledge under any circumstances. "
    "If the answer cannot be found in the CONTEXT, respond exactly with: "
    "\"I could not find an answer to that in the provided document.\" "
    "Never speculate and never fabricate information that is not "
    "explicitly present in the CONTEXT."
)


# ---------------------------------------------------------------------------
# Chunk-based file streaming
# ---------------------------------------------------------------------------

async def _stream_chunks(file: UploadFile, chunk_size: int) -> AsyncGenerator[bytes, None]:
    """
    Yield the uploaded file's contents in bounded binary chunks.

    Using `await file.read(chunk_size)` in a loop (rather than a single
    unbounded `await file.read()`) means we only ever hold one chunk_size
    slice of the file in memory at a time, instead of buffering the whole
    upload before we've even validated it.
    """
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        yield chunk


async def read_upload_in_chunks(file: UploadFile) -> str:
    """
    Stream an UploadFile into memory in bounded chunks, enforcing the
    max-size limit *while streaming* rather than after the fact.

    Why this matters: if we read the entire file first and checked
    `len(data) > MAX_FILE_SIZE_BYTES` afterwards, a malicious or oversized
    upload would already have consumed all that memory before being
    rejected. Checking the running total after every chunk lets us abort
    (and free the buffer) as soon as the limit is crossed, without ever
    buffering more than `MAX_FILE_SIZE_BYTES` worth of data.
    """
    buffer = bytearray()
    total_bytes = 0

    async for chunk in _stream_chunks(file, settings.STREAM_CHUNK_SIZE_BYTES):
        total_bytes += len(chunk)

        if total_bytes > settings.MAX_FILE_SIZE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"File exceeds the {settings.MAX_FILE_SIZE_BYTES // (1024 * 1024)}MB "
                    "size limit."
                ),
            )

        buffer.extend(chunk)

    try:
        return buffer.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be valid UTF-8 encoded plain text (.txt).",
        ) from exc


# ---------------------------------------------------------------------------
# Async-safe Gemini wrapper
# ---------------------------------------------------------------------------

async def _call_gemini(prompt: str) -> str:
    """
    Run the blocking Gemini SDK call in a worker thread.

    `asyncio.to_thread` offloads the synchronous `generate_content` call
    off of FastAPI's event loop, so a slow AI response for one user does
    not stall every other concurrent request the server is handling.
    """
    try:
        response = await asyncio.to_thread(
            _client.models.generate_content,
            model=settings.GEMINI_MODEL_NAME,
            contents=prompt,
        )
        return (response.text or "").strip()
    except Exception as exc:  # noqa: BLE001 — surfaced as a clean 502 below
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI service error: {exc}",
        ) from exc


async def list_available_models() -> list[str]:
    """
    Self-diagnostic helper: returns model names your GEMINI_API_KEY can
    actually call generateContent on right now.

    Google deprecates/renames Gemini models faster than most SDKs keep up
    with docs for, and access can vary by key/project. If GEMINI_MODEL_NAME
    ever 404s again, call this (e.g. from a Python shell: `import asyncio,
    services; asyncio.run(services.list_available_models())`) instead of
    guessing a new name — it tells you exactly what's available for *your*
    key today.
    """
    def _list() -> list[str]:
        names = []
        for m in _client.models.list():
            # Attribute name has shifted between SDK versions
            # ("supported_actions" vs the older "supported_generation_methods");
            # check both defensively rather than assuming one.
            supported = getattr(m, "supported_actions", None) or getattr(
                m, "supported_generation_methods", []
            )
            if "generateContent" in supported:
                names.append(m.name)
        return names

    return await asyncio.to_thread(_list)


async def generate_summary(document_text: str) -> str:
    """Produce a concise, bullet-oriented executive summary of the document."""
    prompt = (
        f"{_RAG_SYSTEM_INSTRUCTION}\n\n"
        "Summarize the CONTEXT below into 4-6 concise executive bullet points. "
        "Prefix each bullet with a hyphen and put each on its own line. "
        "Do not add commentary before or after the bullets.\n\n"
        f"CONTEXT:\n{document_text}\n\n"
        "SUMMARY:"
    )
    return await _call_gemini(prompt)


async def answer_question(context: str, question: str) -> str:
    """Answer a user question strictly from the supplied document context (RAG)."""
    prompt = (
        f"{_RAG_SYSTEM_INSTRUCTION}\n\n"
        f"CONTEXT:\n{context}\n\n"
        f"QUESTION:\n{question}\n\n"
        "ANSWER:"
    )
    return await _call_gemini(prompt)