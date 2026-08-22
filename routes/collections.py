from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/api/collections")


class _CreateCollection(BaseModel):
    name: str
    description: str = ""


class _UpdateCollection(BaseModel):
    name: str | None = None
    description: str | None = None


class _AddItem(BaseModel):
    history_id: int


class _Reorder(BaseModel):
    item_ids: list[int]


@router.get("")
async def list_collections(request: Request):
    user = get_user_email(request)
    return {"collections": db.list_collections(user)}


@router.post("")
async def create_collection(req: _CreateCollection, request: Request):
    user = get_user_email(request)
    name = req.name.strip()
    if not name:
        return JSONResponse({"error": "Name required"}, status_code=400)
    cid = db.create_collection(user, name, req.description.strip())
    coll = db.get_collection(user, cid)
    coll["item_count"] = 0
    return {"created": cid, "collection": coll}


@router.get("/{collection_id}")
async def collection_detail(collection_id: int, request: Request):
    user = get_user_email(request)
    coll = db.get_collection(user, collection_id)
    if coll is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    items = db.get_collection_items(user, collection_id)
    return {**coll, "items": items or []}


@router.put("/{collection_id}")
async def update_collection(collection_id: int, req: _UpdateCollection, request: Request):
    user = get_user_email(request)
    if req.name is None and req.description is None:
        return JSONResponse({"error": "Nothing to update"}, status_code=400)
    ok = db.update_collection(
        user, collection_id,
        name=req.name.strip() if req.name is not None else None,
        description=req.description.strip() if req.description is not None else None,
    )
    if not ok:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"saved": collection_id}


@router.delete("/{collection_id}")
async def delete_collection(collection_id: int, request: Request):
    user = get_user_email(request)
    if not db.delete_collection(user, collection_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": collection_id}


@router.post("/{collection_id}/items")
async def add_item(collection_id: int, req: _AddItem, request: Request):
    user = get_user_email(request)
    item_id = db.add_collection_item(user, collection_id, req.history_id)
    if item_id is None:
        # Distinguish duplicate from not-found for a friendlier message.
        coll = db.get_collection(user, collection_id)
        if coll is None:
            return JSONResponse({"error": "Collection not found"}, status_code=404)
        hist = db.get_history_record(user, req.history_id)
        if hist is None:
            return JSONResponse({"error": "History item not found"}, status_code=404)
        return JSONResponse({"error": "Already in collection"}, status_code=409)
    return {"added": item_id, "history_id": req.history_id}


@router.delete("/{collection_id}/items/{item_id}")
async def remove_item(collection_id: int, item_id: int, request: Request):
    user = get_user_email(request)
    if not db.remove_collection_item(user, collection_id, item_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"removed": item_id}


@router.put("/{collection_id}/reorder")
async def reorder_items(collection_id: int, req: _Reorder, request: Request):
    user = get_user_email(request)
    if not db.reorder_collection_items(user, collection_id, req.item_ids):
        return JSONResponse({"error": "Not found"}, status_code=404)
    items = db.get_collection_items(user, collection_id)
    return {"reordered": collection_id, "order": [i["item_id"] for i in items or []]}
