from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import core.db as db
from nyx_step import get_user_email

router = APIRouter(prefix="/daw")


class _CreateProject(BaseModel):
    name: str = "Untitled Project"


class _UpdateProject(BaseModel):
    name: str | None = None
    data: dict | None = None


@router.get("/projects")
async def list_projects(request: Request):
    user = get_user_email(request)
    return {"projects": db.list_daw_projects(user)}


@router.post("/projects")
async def create_project(req: _CreateProject, request: Request):
    user = get_user_email(request)
    pid = db.create_daw_project(user, req.name.strip() or "Untitled Project")
    return {"id": pid, "name": req.name.strip() or "Untitled Project"}


@router.get("/projects/{project_id}")
async def get_project(project_id: int, request: Request):
    user = get_user_email(request)
    p = db.get_daw_project(user, project_id)
    if p is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    p.pop("user_email", None)
    return p


@router.put("/projects/{project_id}")
async def update_project(project_id: int, req: _UpdateProject, request: Request):
    user = get_user_email(request)
    if req.name is None and req.data is None:
        return JSONResponse({"error": "Nothing to update"}, status_code=400)
    ok = db.update_daw_project(user, project_id, name=req.name, data=req.data)
    if not ok:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"saved": project_id}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, request: Request):
    user = get_user_email(request)
    if not db.delete_daw_project(user, project_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"deleted": project_id}
