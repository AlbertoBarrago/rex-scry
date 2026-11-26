--- rex-diagnostics: load the diagnostics captured by `rex-diagnostics run` into
--- a quickfix list of their own.
---
--- The plugin only reads: it asks the CLI for `list --json` (the documented,
--- versioned contract) and never parses the state file itself. It owns one
--- quickfix list, found again by its id, and replaces that list's items in
--- place ('r' action), so `:cnext`/`:cprev` keep working and every other
--- quickfix list (from :make, :grep, LSP) stays untouched.
---
--- Only diagnostics inside the workspace (those with `relativeFile`) become
--- quickfix items: build output is untrusted, and `:cc` must not open a file
--- the CLI's `open` would refuse.
---
--- Positions: the CLI reports one-based lines and columns. Quickfix `lnum` is
--- one-based and `col` is a one-based byte index; tools count characters, so
--- the column can land early on lines with multibyte characters before it.
local M = {}

local SCHEMA_VERSION = 1
local TITLE = "rex-diagnostics"

M.config = {
  --- Command that runs the CLI (a list, never passed through a shell).
  cmd = { "rex-diagnostics" },
  --- Refresh the list when a run finishes in this workspace (only once the list exists).
  auto_refresh = true,
  --- Open the quickfix window after :RexDiagnostics when there is something to show.
  open = true,
}

local qf_id = nil
--- The directory and filters of the last explicit load: refreshes reuse them.
local last = nil
--- Increments per request; a response older than the newest one is dropped.
local generation = 0
local watcher = nil
local watched_path = nil

local TYPE = { error = "E", warning = "W", info = "I", hint = "N" }

--- @param d table one diagnostic from `list --json`
--- @return table quickfix item
local function to_item(d)
  local lines = vim.split(d.message, "\n", { plain = true, trimempty = true })
  local text = table.concat(lines, " ")
  local tag = d.code and (d.source .. " " .. d.code) or d.source
  return {
    filename = d.file,
    lnum = d.line,
    col = d.column or 0,
    end_lnum = d.endLine or 0,
    end_col = d.endColumn or 0,
    type = TYPE[d.severity] or "E",
    text = text .. " [" .. tag .. "]",
    user_data = { id = d.id, runId = d.runId, source = d.source, code = d.code },
  }
end

--- The id of our list when it is still on the quickfix stack (old lists drop
--- off once the stack holds ten), else nil.
local function our_list()
  if not qf_id then
    return nil
  end
  local info = vim.fn.getqflist({ id = qf_id, title = 0 })
  if info.id == qf_id and info.title == TITLE then
    return qf_id
  end
  qf_id = nil
  return nil
end

--- Diagnostic ids of a list's items, in order.
local function ids_of(items)
  local ids = {}
  for _, it in ipairs(items) do
    local ud = it.user_data
    table.insert(ids, type(ud) == "table" and ud.id or "")
  end
  return ids
end

--- @param result table decoded `list --json`
--- @param select boolean make our list the current one (explicit loads only)
--- @return integer items, integer skipped (outside the workspace)
local function apply(result, select)
  local items, skipped = {}, 0
  for _, d in ipairs(result.diagnostics) do
    if d.relativeFile then
      table.insert(items, to_item(d))
    else
      skipped = skipped + 1
    end
  end
  local what = { items = items, title = TITLE, context = { rex_diagnostics = true, workspace = result.workspace.root } }
  local id = our_list()
  if id then
    local old = vim.fn.getqflist({ id = id, items = 0, idx = 0 })
    local old_ids = ids_of(old.items)
    local new_ids = ids_of(items)
    if not vim.deep_equal(old_ids, new_ids) then
      -- Keep the cursor on the same diagnostic when it is still there.
      local current = old_ids[old.idx]
      what.idx = 1
      for i, nid in ipairs(new_ids) do
        if nid == current then
          what.idx = i
          break
        end
      end
      what.id = id
      vim.fn.setqflist({}, "r", what)
    end
  else
    -- Appended at the end of the stack: ' ' alone would free every list after the current one.
    what.nr = "$"
    vim.fn.setqflist({}, " ", what)
    qf_id = vim.fn.getqflist({ nr = "$", id = 0 }).id
  end
  if select then
    local nr = vim.fn.getqflist({ id = qf_id, nr = 0 }).nr
    local current = vim.fn.getqflist({ nr = 0 }).nr
    if nr > 0 and nr ~= current then
      vim.cmd("silent " .. nr .. "chistory")
    end
  end
  return #items, skipped
end

--- Runs the CLI with args (a list) in dir.
--- @param args string[]
--- @param dir string
--- @param on_done fun(ok: boolean, out: string)
--- @param wait boolean|nil block until done (tests)
local function call(args, dir, on_done, wait)
  local argv = vim.list_extend(vim.deepcopy(M.config.cmd), args)
  local function result(res)
    return res.code == 0, res.code == 0 and res.stdout or (res.stderr ~= "" and res.stderr or ("exit " .. res.code))
  end
  if wait then
    local ok, job = pcall(vim.system, argv, { text = true, cwd = dir })
    if not ok then
      on_done(false, tostring(job))
      return
    end
    on_done(result(job:wait()))
    return
  end
  local ok, err = pcall(vim.system, argv, { text = true, cwd = dir }, function(res)
    local done, out = result(res)
    vim.schedule(function()
      on_done(done, out)
    end)
  end)
  if not ok then
    on_done(false, tostring(err))
  end
end

local function notify(msg, level)
  vim.notify("rex-diagnostics: " .. msg, level or vim.log.levels.INFO)
end

--- Watches the workspace's state file and refreshes our list when it changes,
--- with the directory and filters of the last explicit load.
local function watch(dir)
  if not M.config.auto_refresh or not vim.uv then
    return
  end
  -- `path` also creates the state directory, so it can be watched before the first run.
  call({ "path", "-C", dir }, dir, function(ok, out)
    if not ok then
      return
    end
    local path = vim.trim(out)
    if path == watched_path then
      return
    end
    local handle = vim.uv.new_fs_event()
    local timer = vim.uv.new_timer()
    if not handle or not timer then
      return
    end
    local name = vim.fs.basename(path)
    -- The CLI replaces the file atomically (rename), so watch its directory.
    local started, err = handle:start(vim.fs.dirname(path), {}, function(e, file)
      if e or file ~= name then
        return
      end
      timer:stop()
      timer:start(200, 0, vim.schedule_wrap(function()
        if our_list() and last then
          M.load({ dir = last.dir, args = last.args, silent = true, open = false, refresh = true })
        end
      end))
    end)
    if not started then
      handle:close()
      timer:close()
      notify("cannot watch " .. vim.fs.dirname(path) .. ": " .. tostring(err), vim.log.levels.WARN)
      return
    end
    if watcher then
      watcher:stop()
      watcher:close()
    end
    watcher = handle
    watched_path = path
  end)
end

--- Loads the workspace's diagnostics into our quickfix list.
--- @param opts table|nil { dir?, args?, open?, silent?, wait?, refresh? }
function M.load(opts)
  opts = opts or {}
  local dir = opts.dir or vim.fn.getcwd()
  local filters = opts.args or {}
  local args = { "list", "--json", "-C", dir }
  vim.list_extend(args, filters)
  generation = generation + 1
  local mine = generation
  call(args, dir, function(ok, out)
    if mine ~= generation then
      return -- a newer load already answered or is on its way
    end
    if not ok then
      notify(vim.trim(out), vim.log.levels.ERROR)
      return
    end
    local decoded_ok, result = pcall(vim.json.decode, out)
    if not decoded_ok or type(result) ~= "table" or result.schemaVersion ~= SCHEMA_VERSION then
      notify("unexpected output from `rex-diagnostics list --json`", vim.log.levels.ERROR)
      return
    end
    if not opts.refresh then
      last = { dir = dir, args = filters }
    end
    local n, skipped = apply(result, not opts.refresh)
    if not opts.silent then
      local msg = n == 0 and "no diagnostics" or (n .. " diagnostic" .. (n == 1 and "" or "s"))
      if skipped > 0 then
        msg = msg .. " (" .. skipped .. " outside the workspace left out)"
      end
      notify(msg)
    end
    local open = opts.open
    if open == nil then
      open = M.config.open
    end
    if open and n > 0 then
      vim.cmd("copen")
    end
  end, opts.wait)
  if not opts.refresh then
    watch(dir)
  end
end

--- Empties our quickfix list and clears the workspace's stored diagnostics.
function M.clear(opts)
  opts = opts or {}
  local dir = opts.dir or vim.fn.getcwd()
  call({ "clear", "-C", dir }, dir, function(ok, out)
    if not ok then
      notify(vim.trim(out), vim.log.levels.ERROR)
      return
    end
    local id = our_list()
    if id then
      vim.fn.setqflist({}, "r", { id = id, items = {} })
    end
  end, opts.wait)
end

--- @param opts table|nil overrides for M.config
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
end

--- For tests: the id of the list this plugin owns.
function M.list_id()
  return our_list()
end

return M
