from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

import services
from config import settings
from schemas import AskRequest, AskResponse, UploadResponse

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Upload a .txt document, get an AI-generated executive summary, "
    "and ask follow-up questions answered strictly from that document.",
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.get("/", tags=["Health"])
async def health_check() -> dict:
    """Simple liveness probe."""
    return {"status": "ok", "service": settings.APP_NAME}


@app.get("/api/debug/models", tags=["Health"])
async def list_models() -> dict:
    """
    Lists the Gemini models your GEMINI_API_KEY currently has access to
    for generateContent. Handy for confirming GEMINI_MODEL_NAME in
    config.py is still valid without digging through Google's docs —
    model availability changes faster than most reference material does.
    """
    return {"available_models": await services.list_available_models()}


@app.post(
    "/api/documents/upload",
    response_model=UploadResponse,
    tags=["Documents"],
    summary="Upload a .txt document, stream-validate it, and summarize it",
)
async def upload_document(file: UploadFile = File(...)) -> UploadResponse:
    """
    Accepts multipart/form-data with a single `.txt` file.

    Flow:
      1. Reject non-.txt uploads immediately (before reading any bytes).
      2. Stream the file in bounded chunks via services.read_upload_in_chunks,
         which enforces the 5MB limit *while* reading rather than after
         buffering the whole file (see services.py for the memory-efficiency
         rationale).
      3. Generate an executive summary via the async-wrapped Gemini call.
    """
    if not file.filename.lower().endswith(".txt"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .txt files are supported.",
        )

    raw_text = await services.read_upload_in_chunks(file)

    if not raw_text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is empty.",
        )

    summary = await services.generate_summary(raw_text)

    return UploadResponse(
        filename=file.filename,
        character_count=len(raw_text),
        raw_text=raw_text,
        summary=summary,
    )


@app.post(
    "/api/documents/chat",
    response_model=AskResponse,
    tags=["Q&A"],
    summary="Ask a question, answered strictly from the supplied document context",
)
async def ask_question(payload: AskRequest) -> AskResponse:
    """
    Accepts a validated AskRequest (context + question) and routes it to
    the RAG-constrained Gemini service. Pydantic validation in schemas.py
    guarantees `payload.context` and `payload.question` are non-empty
    strings before this handler body ever runs.
    """
    answer = await services.answer_question(payload.context, payload.question)

    return AskResponse(answer=answer, question=payload.question)