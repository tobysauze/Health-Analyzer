import sys
import os
import time
import subprocess
import json

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
            garth.login(email, password)
            print("[WRAPPER] Login successful!")
            
            # Save session for GarminDB to use
            if not os.path.exists(SESSION_DIR):
                os.makedirs(SESSION_DIR)
            garth.save(SESSION_DIR)
            print(f"[WRAPPER] Session saved to {SESSION_DIR}")

            # CRITICAL FIX: GarminDB strictly requires credentials in the config file
            # or it fails with "Missing config" and crashes.
            # Since we have the valid credentials here, we write them to the config.
            config_file = os.path.join(GARMINDB_DIR, "GarminConnectConfig.json")
            try:
                config_data = {}
                if os.path.exists(config_file):
                    with open(config_file, 'r') as f:
                        try:
                            config_data = json.load(f)
                        except json.JSONDecodeError:
                            config_data = {}
                
                # Ensure structure exists
                if "credentials" not in config_data:
                    config_data["credentials"] = {}
                
                config_data["credentials"]["username"] = email
                config_data["credentials"]["password"] = password
                
                with open(config_file, 'w') as f:
                    json.dump(config_data, f, indent=4)
                print(f"[WRAPPER] Credentials written to {config_file}")
                
                # Verify content (redacted)
                with open(config_file, 'r') as f:
                    verify_data = json.load(f)
                    user = verify_data.get('credentials', {}).get('username')
                    print(f"[WRAPPER] VERIFICATION: Config file contains username: {user}")
                
            except Exception as e:
                print(f"[WRAPPER] Warning: Failed to write config file: {e}")
            
        except Exception as e:
            print(f"[WRAPPER] Login failed: {e}")
            sys.exit(1)

    # 3. Launch the actual CLI tool IN-PROCESS
    # This ensures the `garth` module (and its authenticated session) is shared.
    
    import runpy
    
    # Locate the script
    target_cli = "garmindb_cli.py"
    target_path = None
    
    # Try finding it in path
    if len(sys.argv) > 1 and sys.argv[1].endswith(".py"):
         # If user passed the script path explicitly
         candidate = sys.argv[1]
         if os.path.exists(candidate):
             target_path = candidate
             # Remove wrapper from argv so CLI sees [script, flags...]
             sys.argv.pop(0)
    
    if not target_path:
        # Check common locations or PATH
        path_dirs = os.environ.get("PATH", "").split(os.pathsep)
        # Add /usr/local/bin explicitly as seen in logs
        if "/usr/local/bin" not in path_dirs:
            path_dirs.append("/usr/local/bin")
            
        for d in path_dirs:
            p = os.path.join(d, target_cli)
            if os.path.exists(p):
                target_path = p
                break
    
    if not target_path:
        # Fallback based on previous error log
        target_path = "/usr/local/bin/garmindb_cli.py"
    
    # Monkey-patch garth.Client to return our authenticated global client
    # This prevents garmindb from creating a new, unauthenticated instance.
    print("[WRAPPER] Monkey-patching garth.Client...")
    
    # Store original just in case (though we won't use it)
    _OriginalClient = garth.Client 
    
    class AuthenticatedClientProxy:
        def __new__(cls, *args, **kwargs):
            # Always return the global 'garth.client' which we just logged in.
            return garth.client
            
    garth.Client = AuthenticatedClientProxy
    
    print(f"[WRAPPER] Launching in-process: {target_path}")
    print(f"[WRAPPER] Args: {sys.argv}")
    print("---------------------------------------------------")
    try:
        # Patch sys.argv to look like: [garmindb_cli.py, --a, --b...]
        # Currently sys.argv[0] is garmin_auth_wrapper.py (unless popped above)
        # If we didn't pop above (because arg1 turned out to be the script name we found in PATH), we should replace argv[0]
        if sys.argv[0].endswith("garmin_auth_wrapper.py"):
             sys.argv[0] = target_path
             # If the second arg was the script name (e.g. wrapper.py garmindb_cli.py ...), remove it to avoid dup
             if len(sys.argv) > 1 and "garmindb_cli" in sys.argv[1]:
                 sys.argv.pop(1)
        
        # Inject -f if missing, just in case
        config_dir_path = GARMINDB_DIR
        if "-f" not in sys.argv:
             print(f"[WRAPPER] Injecting -f {config_dir_path}")
             sys.argv.insert(1, config_dir_path)
             sys.argv.insert(1, "-f")

        runpy.run_path(target_path, run_name='__main__')
        
    except Exception as e:
        print(f"[WRAPPER] Execution failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
