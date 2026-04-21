# YApi OpenAPI Notes

This skill uses these YApi endpoints:

- `GET /api/interface/getCatMenu`
  - list categories for a project
- `POST /api/interface/add_cat`
  - create a category
- `GET /api/interface/list`
  - list interfaces in a project
- `GET /api/interface/get`
  - get interface details
- `POST /api/interface/save`
  - create or update an interface

Expected config fields:

- `baseUrl`
- `token`
- `projectId`

Matching rule:

- same HTTP method
- same full path

Category rule:

- default to controller class name

Update rule:

- when a match is found, fetch detail and include `_id` in `save`
- otherwise create with `save`
