import os
from agno.models.google import Gemini

def get_google_model(model_id: str) -> Gemini:
    """Instantiate and return an Agno Google Gemini model instance."""
    api_key = os.getenv("GOOGLE_API_KEY")
    return Gemini(
        id=model_id,
        api_key=api_key
    )
