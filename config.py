from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    GEMINI_MODEL_NAME: str = "gemini-flash-latest"

    MAX_FILE_SIZE_BYTES: int = 5 * 1024 * 1024  # 5MB — mirrors the frontend limit
    STREAM_CHUNK_SIZE_BYTES: int = 64 * 1024      # 64KB per chunk while reading uploads

    # --- CORS --------------------------------------------------------------
    ALLOWED_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # --- App metadata ----------------------------------------------------
    APP_NAME: str = "AI-Powered Enterprise Document Analyzer & Automated Report Agent"
    APP_VERSION: str = "1.0.0"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()