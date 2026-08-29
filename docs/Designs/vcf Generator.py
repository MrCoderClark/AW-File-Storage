import base64
import pandas as pd
from PIL import Image
import io
from tkinter import filedialog
import tkinter as tk
import os
import re

def parse_phone_number(phone_str):

    if not phone_str or not isinstance(phone_str, str):
        return None    

    phone_str = phone_str.strip()    

    extension = ''
    extension_match = re.search(r'(?:x|ext|extension)[:\s]*([0-9]+)', phone_str, re.IGNORECASE)
    if extension_match:
        extension = extension_match.group(1)
        phone_str = phone_str[:extension_match.start()].strip()    

    digits = re.sub(r'\D', '', phone_str)    
   
    if len(digits) == 10:  
        formatted = f"1{digits}"
    elif len(digits) == 11 and digits[0] == '1':
        formatted = digits
    elif len(digits) == 7:  
        return None
    else:     
        return None    
   
    if extension:
        formatted = f"{formatted},,{extension}"
    
    return formatted

def image_to_base64(image_path):
    with open(image_path, 'rb') as img_file:
        img = Image.open(img_file)
        buffered = io.BytesIO()
        img.save(buffered, format=img.format)
        return base64.b64encode(buffered.getvalue()).decode('utf-8')

def excel_to_vcf():
    root = tk.Tk()
    root.withdraw()
    file_path = filedialog.askopenfilename(filetypes=[("Excel files", "*.xlsx")])
    if not file_path:
        print("No file selected. Exiting.")
        return    

    df = pd.read_excel(file_path)
    

    excel_directory = os.path.dirname(file_path)    

    for index, row in df.iterrows():
        first_name = row['First Name']
        last_name = row['Last Name']
        full_name = row['Full Name'] if 'Full Name' in row else f'{first_name} {last_name}'
        email = row['Email']
        phone = row['Mobile Phone']
        organization = row['Organization']
        job_title = row['Job Title']
        address = row['Address']
        city = row['City']
        state = row['State']
        zip_code = row['Zip Code']
        country = row['Country']
        website = row['Website']
        work_phone = row['Work Phone']
        work_fax = row['Fax']
        picture_name = row['Picture Name']
        picture_path = os.path.join(excel_directory, str(picture_name)) if picture_name else None  
        

        if picture_path and os.path.exists(picture_path):
            picture_data = image_to_base64(picture_path)
            picture_data = f'PHOTO;ENCODING=b;TYPE={picture_name.split(".")[-1].upper()}:' + picture_data
        else:
            picture_data = ''
        
        vcf_file_path = os.path.join(excel_directory, f'{first_name}_{last_name}.vcf')
        with open(vcf_file_path, 'w', encoding='utf-8') as vcf_file:
            vcf_file.write('BEGIN:VCARD\n')
            vcf_file.write('VERSION:3.0\n')
            vcf_file.write(f'N:{last_name};{first_name};;;\n')
            vcf_file.write(f'FN:{full_name}\n')
            vcf_file.write(f'EMAIL;TYPE=WORK:{email}\n')
            if isinstance(phone, str) and phone.strip(): 
                parsed_phone = parse_phone_number(phone)
                if parsed_phone:
                    vcf_file.write(f'TEL;TYPE=CELL,VOICE:{parsed_phone}\n') 
            if organization:
                vcf_file.write(f'ORG:{organization}\n')
            if job_title:
                vcf_file.write(f'TITLE:{job_title}\n')
            if address:
                vcf_file.write(f'ADR;TYPE=WORK:;;{address};{city};{state};{zip_code};{country}\n')
            if website:
                vcf_file.write(f'URL;TYPE=WORK:{website}\n') 
            if work_phone:
                parsed_work_phone = parse_phone_number(work_phone)
                if parsed_work_phone:
                    vcf_file.write(f'TEL;TYPE=WORK,VOICE:{parsed_work_phone}\n')
                elif isinstance(work_phone, str) and work_phone.strip():            
                    vcf_file.write(f'TEL;TYPE=WORK,VOICE:{work_phone.strip()}\n')
            if work_fax:
                vcf_file.write(f'TEL;TYPE=WORK,FAX:{work_fax}\n')
            if picture_data:
                vcf_file.write(f'{picture_data}\n')
            vcf_file.write('END:VCARD\n')
        print(f"VCF file for {full_name} saved successfully at {vcf_file_path}.")
    
    print("VCF files generated successfully.")

excel_to_vcf()
