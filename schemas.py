from pydantic import BaseModel, Field, field_validator
class UploadResponse(BaseModel):
    """Returned by POST /upload once a document has been ingested and summarized."""

    filename: str
    character_count: int
    raw_text: str
    summary: str


class AskRequest(BaseModel):

    context: str = Field(
        ...,
        min_length=1,
        description="Full or relevant document text the answer must be grounded in.",
    )
    question: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="The user's question about the document.",
    )

    @field_validator("context", "question")
    @classmethod
    def not_blank(cls, value: str) -> str:
        """Reject whitespace-only strings that would otherwise pass min_length=1."""
        if not value.strip():
            raise ValueError("must not be blank or whitespace-only")
        return value.strip()


class AskResponse(BaseModel):
    """Returned by POST /ask."""

    answer: str
    question: str


class ErrorResponse(BaseModel):
    """Consistent error shape returned to the frontend on handled failures."""

    detail: str