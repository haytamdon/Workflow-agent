import os
from agno.models.openai import OpenAIChat

def get_openai_model(model_id: str) -> OpenAIChat:
    """Instantiate and return an Agno OpenAIChat model instance."""
    api_key = os.getenv("OPENAI_API_KEY")
    return OpenAIChat(
        id=model_id,
        api_key=api_key
    )
