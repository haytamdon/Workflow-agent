import os
from agno.models.openrouter import OpenRouter

def get_openrouter_model(model_id: str) -> OpenRouter:
    """Instantiate and return an Agno OpenRouter model instance."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    return OpenRouter(
        id=model_id,
        api_key=api_key
    )
