-- rex-diagnostics: browse and open the diagnostics of the focused pane's
-- workspace from the Rex command palette.
--
-- Install:
--   cp "$(npm root -g)/rex-diagnostics/rex/rex-diagnostics.lua" ~/.config/rex/
--   echo 'require("rex-diagnostics")' >> ~/.config/rex/init.lua
--   rex config check && rex config reload
--
-- Then, in a pane sitting in your project:
--   ctrl+b d   pick a diagnostic and open it (rex_diagnostics)
--   ctrl+b j   open the next one (rex_diagnostics_next)
--   ctrl+b k   open the previous one (rex_diagnostics_prev)
--   ctrl+b D   open the live panel in a split beside the pane (rex_diagnostics_panel)
-- "Diagnostics: Copy…" and "Diagnostics: Clear" are in the command palette.
--
-- The workspace is found from the working directory the focused terminal
-- reports (OSC 7: zsh, fish and most prompts report it). Nothing here parses
-- terminal output: diagnostics come from `rex-diagnostics list --json`.

-- Program to run. Use an absolute path if Rex still can't find it.
local REX_DIAGNOSTICS_BIN = "rex-diagnostics"

-- Rex runs commands with its own environment, which skips ~/.zshrc. Common
-- user bin dirs are prepended so an `npm link`ed binary, rex-nvim and `node`
-- are found, including node from version managers (volta, mise, asdf, fnm).
-- With nvm, set REX_DIAGNOSTICS_BIN above to an absolute path, or add nvm's
-- current bin directory here.
local home = os.getenv("HOME") or ""
local EXTRA_PATH = {
  home .. "/.local/bin",
  home .. "/.npm-global/bin",
  home .. "/.n/bin",
  home .. "/.volta/bin",
  home .. "/.local/share/mise/shims",
  home .. "/.asdf/shims",
  home .. "/.local/state/fnm_multishells/default/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
}

local function search_path()
  return table.concat(EXTRA_PATH, ":") .. ":" .. (os.getenv("PATH") or "/usr/bin:/bin")
end

local function env()
  return { PATH = search_path() }
end

local SCHEMA_VERSION = 1
local EX_UNAVAILABLE = 69

local function fail(msg)
  rex.log("warn", "rex-diagnostics: " .. msg)
  error("rex-diagnostics: " .. msg, 0)
end

--- The focused terminal's working directory, from its OSC 7 report
--- (file://host/path, percent-encoded).
local function focused_dir()
  local res, err = rex.block.call("com.superlogical.terminal", "pwd", {})
  if res == nil or res.pwd == nil or res.pwd == "" then
    fail("the focused pane reports no working directory (" .. tostring(err or "no OSC 7") .. ")")
  end
  local path = res.pwd:gsub("^file://[^/]*", "")
  path = path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
  return path
end

--- Runs the CLI with argv (no shell) in dir.
local function cli(args, dir)
  local argv = { REX_DIAGNOSTICS_BIN }
  for _, a in ipairs(args) do table.insert(argv, a) end
  local r, err = rex.exec(argv, { cwd = dir, env = env(), timeout = 30 })
  if r == nil then fail("cannot run " .. REX_DIAGNOSTICS_BIN .. ": " .. tostring(err)) end
  return r
end

local function load(dir, severity)
  local args = { "list", "--json", "-C", dir }
  if severity then
    table.insert(args, "--severity")
    table.insert(args, severity)
  end
  local r = cli(args, dir)
  if not r.ok then fail(r.stderr ~= "" and r.stderr or ("list exited with " .. tostring(r.code))) end
  local data = rex.json.decode(r.stdout)
  if type(data) ~= "table" or data.schemaVersion ~= SCHEMA_VERSION then
    fail("unexpected output from `list --json`; update rex-diagnostics.lua to match the CLI")
  end
  return data
end

local LABEL = { error = "ERROR", warning = "WARNING", info = "INFO", hint = "HINT" }

local function where(d)
  local s = (d.relativeFile or d.file) .. ":" .. d.line
  if d.column then s = s .. ":" .. d.column end
  return s
end

local MAX_ITEMS = 2000 -- rex.ui.pick shows at most 2,000 items

local function pick(data, title, confirm)
  local items = {}
  for i, d in ipairs(data.diagnostics) do
    if i > MAX_ITEMS then break end
    table.insert(items, {
      id = d.id,
      title = where(d),
      subtitle = (d.message:gsub("\n.*", "")),
      detail = LABEL[d.severity] or d.severity,
      icon = "code",
    })
  end
  local c = data.counts
  local summary = string.format("%d errors · %d warnings", c.error, c.warning)
  if #data.diagnostics > MAX_ITEMS then
    summary = summary .. string.format(", first %d shown", MAX_ITEMS)
  end
  if #items == 0 then
    rex.ui.pick{ title = title .. ": no diagnostics", items = { { id = "none", title = "Nothing captured yet", subtitle = "Run a build with: rex-diagnostics run -- <command>" } } }
    return nil
  end
  local id = rex.ui.pick{ title = title .. " (" .. summary .. ")", placeholder = "Filter by file or message", confirm = confirm, items = items }
  if id == nil then return nil end
  for _, d in ipairs(data.diagnostics) do
    if d.id == id then return d end
  end
  return nil
end

--- Opens d through the CLI (rex-nvim when installed). Without rex-nvim,
--- falls back to a new nvim split beside the focused pane.
local function open(d, dir, ctx)
  local r = cli({ "open", d.id, "-C", dir, "--no-editor" }, dir)
  if r.ok then return end
  if r.code ~= EX_UNAVAILABLE then
    fail(r.stderr ~= "" and r.stderr or ("open exited with " .. tostring(r.code)))
  end
  -- The CLI validated the path and printed its canonical form (symlinks
  -- resolved) as PATH:LINE[:COL]: open that one, not the stored name.
  local printed = (r.stdout or ""):gsub("%s+$", "")
  local file, line, col = printed:match("^(.*):(%d+):(%d+)$")
  if not file then
    file, line = printed:match("^(.*):(%d+)$")
  end
  if not file or file == "" then fail("open printed no location") end
  local _, err = rex.session.new_split{
    anchor_id = ctx.block_id,
    direction = "horizontal",
    side      = "after",
    ratio     = 0.5,
    focus     = true,
    layout    = rex.layout.block{
      flavor  = "com.superlogical.terminal.shell",
      label   = "diagnostic",
      options = {
        -- env sets PATH for nvim itself, since a terminal block starts with Rex's environment.
        command = { "/usr/bin/env", "PATH=" .. search_path(), "nvim", "+call cursor(" .. line .. "," .. (col or 1) .. ")", "--", file },
        cwd     = dir,
      },
    },
  }
  if err ~= nil then error(err, 0) end
end

rex.action{
  name        = "rex_diagnostics",
  title       = "Diagnostics…",
  description = "Pick one of the workspace's captured diagnostics and open it in Neovim.",
  keywords    = "diagnostics errors warnings build lint test quickfix",
  args        = { severity = "string?" },
  run         = function(ctx, args)
    local dir = focused_dir()
    local d = pick(load(dir, args.severity), "Diagnostics", "Open")
    if d then open(d, dir, ctx) end
  end,
}

local function step(direction)
  return function(ctx, args)
    local dir = focused_dir()
    local r = cli({ direction, "--json", "-C", dir }, dir)
    -- At either end of the list there is nothing to do; any other failure is reported.
    if r.code == 1 and r.stderr:find("no next diagnostic", 1, true) then return end
    if r.code == 1 and r.stderr:find("no previous diagnostic", 1, true) then return end
    if not r.ok then fail(r.stderr ~= "" and r.stderr or ("exit " .. tostring(r.code))) end
    open(rex.json.decode(r.stdout), dir, ctx)
  end
end

rex.action{
  name        = "rex_diagnostics_next",
  title       = "Diagnostics: Next",
  description = "Open the workspace's next diagnostic.",
  keywords    = "diagnostics next error",
  run         = step("next"),
}

rex.action{
  name        = "rex_diagnostics_prev",
  title       = "Diagnostics: Previous",
  description = "Open the workspace's previous diagnostic.",
  keywords    = "diagnostics previous error",
  run         = step("prev"),
}

rex.action{
  name        = "rex_diagnostics_panel",
  title       = "Diagnostics: Panel",
  description = "Open the live diagnostics panel of the focused pane's workspace in a split beside it.",
  keywords    = "diagnostics panel tui errors warnings live",
  args        = { severity = "string?" },
  run         = function(ctx, args)
    local dir = focused_dir()
    local command = { "/usr/bin/env", "PATH=" .. search_path(), REX_DIAGNOSTICS_BIN, "ui", "-C", dir }
    if args.severity then
      table.insert(command, "--severity")
      table.insert(command, args.severity)
    end
    local _, err = rex.session.new_split{
      anchor_id = ctx.block_id,
      direction = "horizontal",
      side      = "after",
      -- Share kept by the existing pane; the panel gets the rest.
      ratio     = 0.55,
      focus     = true,
      layout    = rex.layout.block{
        flavor  = "com.superlogical.terminal.shell",
        label   = "diagnostics",
        options = { command = command, cwd = dir },
      },
    }
    if err ~= nil then error(err, 0) end
  end,
}

rex.action{
  name        = "rex_diagnostics_copy",
  title       = "Diagnostics: Copy…",
  description = "Pick a diagnostic and copy it as file:line:col: severity: message.",
  keywords    = "diagnostics copy clipboard",
  run         = function(ctx, args)
    local dir = focused_dir()
    local d = pick(load(dir, nil), "Copy diagnostic", "Copy")
    if d == nil then return end
    local text = where(d) .. ": " .. d.severity .. ": " .. d.message
    local r, err = rex.exec({ "pbcopy" }, { stdin = text })
    if r == nil or not r.ok then fail("cannot copy (pbcopy): " .. tostring(err or r.stderr)) end
  end,
}

rex.action{
  name        = "rex_diagnostics_clear",
  title       = "Diagnostics: Clear",
  description = "Clear the captured diagnostics of the focused pane's workspace.",
  keywords    = "diagnostics clear reset",
  run         = function(ctx, args)
    local dir = focused_dir()
    local r = cli({ "clear", "-C", dir }, dir)
    if not r.ok then fail(r.stderr) end
  end,
}

-- Change or remove these lines to pick your own keys.
rex.bind("ctrl+b>d", "rex_diagnostics")
rex.bind("ctrl+b>j", "rex_diagnostics_next")
rex.bind("ctrl+b>k", "rex_diagnostics_prev")
rex.bind("ctrl+b>shift+d", "rex_diagnostics_panel")
