-- rex-diagnostics: :RexDiagnostics loads the captured diagnostics into a
-- quickfix list of their own; :RexDiagnosticsClear empties it.
if vim.g.loaded_rex_diagnostics then
  return
end
vim.g.loaded_rex_diagnostics = true

if vim.fn.has("nvim-0.10") == 0 then
  vim.notify("rex-diagnostics: needs Neovim 0.10 or later", vim.log.levels.WARN)
  return
end

-- Extra arguments are CLI filters, e.g. :RexDiagnostics --severity error
vim.api.nvim_create_user_command("RexDiagnostics", function(cmd)
  require("rex-diagnostics").load({ args = cmd.fargs })
end, { nargs = "*", desc = "Load rex-diagnostics into the quickfix list" })

vim.api.nvim_create_user_command("RexDiagnosticsClear", function()
  require("rex-diagnostics").clear()
end, { desc = "Clear this workspace's rex-diagnostics" })
