import os
from agno.models.anthropic import AnthropicChat

def get_anthropic_model(model_id: str) -> AnthropicChat:
    """Instantiate and return an Agno AnthropicChat model instance."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    return AnthropicChat(
        id=model_id,
        api_key=api_key
    )