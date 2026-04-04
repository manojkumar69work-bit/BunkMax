from pydantic import BaseModel
from typing import List, Dict, Any

class ERPImportPayload(BaseModel):
    subjects: List[Dict[str, Any]]
    attendance: Dict[str, Any]