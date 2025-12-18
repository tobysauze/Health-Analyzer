import sys
import os
import time
import subprocess

# Ensure we can import modules from the environment
try:
    import garth
except ImportError:
    print("[WRAPPER] Error: 'garth' module not found. Is it installed?")
    sys.exit(1)

# Configuration matching GarminDB's defaults
GARMINDB_DIR = os.path.expanduser("~/.GarminDb")
SESSION_DIR = os.path.join(GARMINDB_DIR, "garth_session")

def main():
    print("[WRAPPER] Starting Garmin Auth Wrapper...")
    
    # 1. Try to resume existing session
    session_valid = False
    try:
        if os.path.exists(SESSION_DIR):
            garth.resume(SESSION_DIR)
            # rapid check?
            try:
                garth.client.username
                session_valid = True
                print("[WRAPPER] Session resumed successfully.")
            except:
                print("[WRAPPER] Session invalid/expired.")
    except Exception as e:
        print(f"[WRAPPER] Failed to resume session: {e}")

    # 2. If not valid, valid, perform login
    if not session_valid:
        print("[WRAPPER] No valid session found. Starting interactive login...")
        
        # PROMPTS MUST MATCH THE REGEX IN SERVER.JS
        # "Username: " and "Password: "
        
        print("Username:")
        sys.stdout.flush()
        email = sys.stdin.readline().strip()
        if not email:
            print("[WRAPPER] No email provided. Aborting.")
            sys.exit(1)
            
        print("Password:")
        sys.stdout.flush()
        password = sys.stdin.readline().strip()
        if not password:
            print("[WRAPPER] No password provided. Aborting.")
            sys.exit(1)

        try:
            # garth.login handles MFA interactive prompts if needed (hopefully prints to stdout)
            # But the node server expects specific MFA prompts.
            # If garth asks for "Enter MFA code:", we need to make sure server.js catches it.
            # We will rely on Garth's internal print statements or hook it if needed.
            # For now, standard login:
            garth.login(email, password)
            print("[WRAPPER] Login successful!")
            
            # Save session for GarminDB to use
            if not os.path.exists(SESSION_DIR):
                os.makedirs(SESSION_DIR)
            garth.save(SESSION_DIR)
            print(f"[WRAPPER] Session saved to {SESSION_DIR}")
            
        except Exception as e:
            print(f"[WRAPPER] Login failed: {e}")
            # If it's an MFA error, garth might have raised it.
            # We might need a more complex loop for MFA if garth.login() doesn't handle it interactively on stdin/out
            sys.exit(1)

    # 3. Launch the actual GarminDB CLI
    # We pass through all arguments provided to this wrapper
    # args[0] is this script name, so we take slice(1)
    
    # We need to find the garmindb_cli.py executable
    # The server.js passed it as an environment variable or default
    # But here we probably just want to run "garmindb_cli.py" from path.
    
    target_cli = "garmindb_cli.py"
    cmd = [target_cli] + sys.argv[1:]
    
    print(f"[WRAPPER] Launching: {target_cli} {' '.join(sys.argv[1:])}")
    print("---------------------------------------------------")
    sys.stdout.flush()

    # Use run to wait for it, or execvp to replace. 
    # execvp is better to keep PIDs simple, but we want to catch exit code? 
    # Actually execvp replaces the process, so the exit code of this wrapper IS the exit code of the CLI.
    try:
        os.execvp(target_cli, cmd)
    except FileNotFoundError:
        # Fallback: try full path if not in PATH (unlikely if installed in same env)
        print(f"[WRAPPER] Error: {target_cli} not found in PATH.")
        sys.exit(1)

if __name__ == "__main__":
    main()
