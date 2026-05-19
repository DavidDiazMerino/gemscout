from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_db: str = "gemscout"

    voyage_api_key: str = ""

    google_cloud_project: str = ""
    google_cloud_location: str = "us-central1"
    gemini_api_key: str = ""
    # Model name shown in the UI (actual REST call in _gemini_rest hardcodes gemini-2.5-flash)
    gemini_model: str = "gemini-2.5-flash"

    backend_host: str = "0.0.0.0"
    backend_port: int = 8080
    backend_cors_origins: str = "http://localhost:5173"

    slow_request_ms: float = 1000.0

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.backend_cors_origins.split(",") if o.strip()]


settings = Settings()
