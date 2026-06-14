import os
from typing import Any, Optional
from .openrouter import get_openrouter_model
from .google import get_google_model
from .openai import get_openai_model
from .anthropic import get_anthropic_model

def get_model(provider: Optional[str] = None, model_id: Optional[str] = None) -> Any:
    """Factory function to instantiate and return the configured model.
    Defaults to OpenRouter with nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
    if no provider is specified.
    """
    if not provider:
        provider = os.getenv("MODEL_PROVIDER", "openrouter")
    
    provider = provider.lower()
    
    if provider == "openrouter":
        if not model_id:
            model_id = os.getenv("OPENROUTER_MODEL", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")
        return get_openrouter_model(model_id)
        
    elif provider == "google":
        if not model_id:
            model_id = os.getenv("GOOGLE_MODEL", "gemini-2.5-flash")
        return get_google_model(model_id)
        
    elif provider == "openai":
        if not model_id:
            model_id = os.getenv("OPENAI_MODEL", "gpt-4o")
        return get_openai_model(model_id)
    
    elif provider == "anthropic":
        if not model_id:
            model_id = os.getenv("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")
        return get_anthropic_model(model_id)
        
    else:
        raise ValueError(f"Unsupported model provider: {provider}")