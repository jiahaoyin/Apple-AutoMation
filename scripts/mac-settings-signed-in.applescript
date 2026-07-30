#!/usr/bin/env osascript
-- macOS 15 (Sequoia)：检测系统设置 Apple Account 是否已登录
-- Returns "yes" | "no"

on run argv
	tell application "System Events"
		if not (exists process "System Settings") then
			try
				do shell script "open 'x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings'"
				delay 2
			end try
		end if

		if not (exists process "System Settings") then return "no"

		tell process "System Settings"
			-- Check window title for account page
			repeat with w in windows
				set wTitle to title of w
				if wTitle is in {"Apple\u{8D26}\u{6237}", "Apple Account", "\u{767B}\u{5F55}"} then
					-- Check for Sign Out button with ellipsis variant (macOS 15)
					repeat with b in buttons of w
						set n to name of b
						if n is in {"Sign Out", "\u{9000}\u{51FA}\u{767B}\u{5F55}", "Sign out", "Log Out", "Sign Out\u{2026}", "\u{9000}\u{51FA}\u{767B}\u{5F55}\u{2026}", "Log Out\u{2026}"} then return "yes"
					end repeat
					-- Check for email in static texts (account name with @)
					repeat with st in static texts of w
						set v to value of st
						if v contains "@" then return "yes"
					end repeat
					try
						repeat with st in static texts of scroll area 1 of group 1 of w
							set v to value of st
							if v contains "@" then return "yes"
						end repeat
					end try
					-- Check for account name + "Apple\u{8D26}\u{6237}" pattern (logged-in page)
					repeat with st in static texts of w
						set v to value of st
						if v contains "Apple\u{8D26}\u{6237}" or v contains "Apple Account" then return "yes"
					end repeat
				end if
			end repeat
		end tell
	end tell
	return "no"
end run
