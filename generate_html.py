#!/usr/bin/env python3
import csv

html = '''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>PuzzleScript Games</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
        ul { line-height: 1.8; }
        a { color: #0066cc; }
    </style>
</head>
<body>
    <h1>PuzzleScript Games shared in Gists</h1>
    <ul>
'''

with open('gist_results.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        url = row['url']
        title = row['title']
        # Extract username and hash from URL like https://gist.github.com/username/hash
        parts = url.rstrip('/').split('/')
        hash_id = parts[-1]
        username = parts[-2]
        play_url = f'https://darabos.github.io/PuzzleScriptNext/src/play.html?p={hash_id}'
        link_text = f'{title} by {username}'
        # Escape HTML entities
        link_text = link_text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        html += f'        <li><a href="{play_url}">{link_text}</a></li>\n'

html += '''    </ul>
</body>
</html>
'''

with open('games.html', 'w') as f:
    f.write(html)

print('Created games.html')
