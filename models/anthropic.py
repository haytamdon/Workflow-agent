import os
from agno.models.anthropic import Claude

def get_anthropic_model(model_id: str) -> Claude:
    """Instantiate and return an Agno Claude model instance."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    return Claude(
        id=model_id,
        api_key=api_key
    )