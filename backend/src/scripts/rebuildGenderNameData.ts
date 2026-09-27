// ─── Rebuild the Indian name → gender dictionary from source data ─────────────
// Regenerates backend/src/data/indian{Male,Female,Ambiguous}Names.json —
// genderClassifier.ts's dictionary — from two public, real-world name
// datasets: github.com/mbejda's "Indian-Male-Names.csv" / "Indian-Female-
// Names.csv" (~14.8k and ~15.4k full-name rows). Re-run this if either
// source dataset ever gets updated, or to fold in another dataset — add its
// raw URL to SOURCES below and everything else (parsing, conflict
// resolution, output) stays the same.
//
// Usage:
//   npx tsx src/scripts/rebuildGenderNameData.ts
//
// METHODOLOGY (see genderClassifier.ts's own header for the runtime
// consequences of this):
//   1. Each source CSV's `name` column is reduced to a first name — the
//      first non-title token, same extractFirstName() the classifier itself
//      uses — and tallied per gender.
//   2. A first name appearing under only one gender across all sources
//      resolves to that gender outright.
//   3. A first name appearing under BOTH genders is resolved by strong
//      majority (5x+ more common under one gender, with 5+ total
//      occurrences) to that gender; anything less lopsided goes to the
//      ambiguous list instead — never force a guess on a name real data
//      shows genuinely crosses gender lines.
//   4. This is a full rebuild from source each run, not an incremental merge
//      on top of the previous output — so a one-off manual correction to a
//      specific name (discovered the way "Kulvinder"/"Daljit"/"Amritpal"
//      were — see genderClassifier.ts) does NOT survive a re-run by editing
//      the generated JSON directly. Encode any such correction as its own
//      override step below instead (see MANUAL_OVERRIDES) so it survives.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { extractFirstName } from '../utils/genderClassifier.js';

const SOURCES = [
  { url: 'https://gist.githubusercontent.com/mbejda/7f86ca901fe41bc14a63/raw/38adb475c14a3f44df9999c1541f3a72f472b30d/Indian-Male-Names.csv', gender: 'M' as const },
  { url: 'https://gist.githubusercontent.com/mbejda/9b93c7545c9dd93060bd/raw/b582593330765df3ccaae6f641f8cddc16f1e879/Indian-Female-Names.csv', gender: 'F' as const },
];

// This module's own original hand-curated dictionary (several hundred names
// spanning North Indian, Sikh/Punjabi, Muslim, Bengali, Gujarati/Marathi,
// South Indian, Parsi, and Christian/Anglo-Indian naming conventions) —
// several of these communities (Parsi, Christian/Anglo-Indian especially)
// are underrepresented in an India-scraped dataset like mbejda's, so this is
// a PERMANENT additional source, not a one-time seed — applied as an
// unconditional override alongside the automatic dataset resolution below
// (never dropped by a future re-run), with any residual conflict against the
// dataset's own resolution sent to the ambiguous list rather than silently
// picking a side.
const CURATED_MALE = [
  'aakash', 'akash', 'aarav', 'aarush', 'aayush', 'aayan', 'abhay', 'abhijeet', 'abhijit',
  'abhinav', 'abhishek', 'aditya', 'advait', 'ajay', 'akhil', 'akshay', 'akshat', 'alok',
  'aman', 'amar', 'amit', 'amith', 'anand', 'anay', 'aniket', 'anil', 'ankit', 'ankur', 'ankush',
  'anmol', 'anoop', 'anshuman', 'anubhav', 'anup', 'anurag', 'arjun', 'arnav', 'arun', 'arvind',
  'aryan', 'ashish', 'ashok', 'ashutosh', 'atul', 'avinash', 'ayush', 'adarsh', 'akarsh',
  'balram', 'bharat', 'bhaskar', 'bhavesh', 'bhupendra',
  'bhuvan', 'chetan', 'darshan', 'deepak', 'dev', 'devansh', 'devendra', 'dhaval', 'dheeraj',
  'dhruv', 'dinesh', 'divyansh', 'gagan', 'ganesh', 'gaurav', 'girish', 'gopal', 'gyan',
  'harendra', 'harsh', 'harshit', 'harshvardhan', 'hemant', 'himanshu', 'hitesh', 'ishaan',
  'jatin', 'jayant', 'jayaprakash', 'jayesh', 'jitendra', 'kabir', 'kailash', 'kamal', 'kanav', 'karan',
  'kshitij', 'kushal',
  'kartik', 'karthik', 'kaushal', 'keshav', 'kishore', 'krishna', 'kunal', 'lakshya', 'lalit',
  'lokesh', 'mahesh', 'manav', 'manish', 'manoj', 'mayank', 'mohan', 'mohit', 'mukesh',
  'nakul', 'naman', 'narendra', 'naresh', 'naveen', 'navin', 'nikhil', 'nilesh', 'niraj', 'nirmal',
  'nishant', 'nitesh', 'nitin', 'om', 'omkar', 'pankaj', 'paras', 'parth', 'pawan', 'piyush',
  'prabhat', 'prabhu', 'pradeep', 'pramod', 'pranav', 'prashant', 'prateek', 'pratik',
  'praveen', 'pravin', 'punit', 'puneet', 'purushottam', 'rahul', 'raj', 'rajat', 'rajeev',
  'rajendra', 'rajesh', 'rajiv', 'rajkumar', 'raju', 'rakesh', 'raman', 'ramesh', 'ranjan',
  'ranjit', 'ratan', 'raunak', 'rounak', 'ravi', 'ravindra', 'rishab', 'rishabh', 'ritesh', 'rohan',
  'rohit', 'rohith', 'ronak', 'rudra', 'sachin', 'sagar', 'sahil', 'sameer', 'samir', 'sandeep',
  'samarth', 'sanjay', 'sanjeev', 'santosh', 'satish', 'satyendra', 'saurabh', 'sourav', 'shaurya', 'shailendra',
  'shankar', 'shashank', 'shashi', 'shiv', 'shivam', 'shubham', 'shyam', 'siddharth',
  'sohan', 'somesh', 'subhash', 'subodh', 'sudarshan', 'sudhanshu', 'sudhir', 'sumit',
  'sunder', 'sundeep', 'sunil', 'suraj', 'surendra', 'suresh', 'suryakant', 'sushant',
  'swapnil', 'tanmay', 'tarun', 'tejas', 'udayan', 'uday', 'umang', 'umesh', 'upendra',
  'utkarsh', 'utsav', 'vaibhav', 'vansh', 'varun', 'veer', 'vibhor', 'vijay', 'vikas', 'vikram',
  'vikrant', 'vimal', 'vinay', 'vineet', 'vinit', 'vinod', 'vipin', 'vipul', 'vishal',
  'vishnu', 'vivek', 'yash', 'yashwant', 'yatin', 'yogendra', 'yogesh', 'yuvraj',
  'amarjeet', 'amarjit', 'amritpal', 'baljinder', 'balbir', 'balwinder', 'bikram', 'gurbaksh',
  'gurcharan', 'gurdeep', 'gurjeet', 'gurmail', 'gurnam', 'gursimran', 'harbhajan', 'hardeep',
  'harinder', 'harjinder', 'harpal', 'harshdeep', 'harvinder', 'inderjeet', 'inderjit', 'jagdeep', 'jagjit',
  'jagmohan', 'jarnail', 'jaskaran', 'jasvinder', 'jaswant', 'jatinder', 'jogindar', 'kuldeep',
  'kulwinder', 'lakhbir', 'lakhvinder', 'mandeep', 'manjinder', 'manjot', 'narinder',
  'parminder', 'ranbir', 'satnam', 'sukhbir', 'sukhdev', 'sukhjinder', 'sukhwinder',
  'surjeet', 'surinder', 'tarlochan', 'tejinder', 'yadwinder',
  'aamir', 'aarif', 'aasif', 'adnan', 'ahmed', 'ahsan', 'akbar', 'akhtar', 'ali', 'altaf',
  'amaan', 'amjad', 'anwar', 'arbaaz', 'arif', 'arshad', 'asad', 'ashfaq', 'asif', 'ayaan',
  'ayub', 'azad', 'azhar', 'bilal', 'danish', 'ehsaan', 'faisal', 'farhan', 'fardeen', 'farid',
  'farooq', 'fayaz', 'firoz', 'ghulam', 'hamid', 'hamza', 'haroon', 'hasan', 'hassan',
  'hussain', 'ibrahim', 'imran', 'imtiaz', 'iqbal', 'irfan', 'ishaan', 'ismail', 'javed',
  'kaif', 'kamal', 'kamran', 'kashif', 'khalid', 'liaquat', 'mahmood', 'mansoor', 'mehboob',
  'mohsin', 'mubarak', 'mukhtar', 'munir', 'mustafa', 'nadeem', 'nasir', 'nawaz', 'nazim',
  'nizam', 'noman', 'omar', 'parvez', 'qadir', 'rafiq', 'rashid', 'raza', 'rizwan', 'saad',
  'sagheer', 'sajid', 'salaam', 'saleem', 'salim', 'salman', 'sarfaraz', 'shabbir',
  'shadab', 'shahbaz', 'shahid', 'shahnawaz', 'shahrukh', 'shakeel', 'shamim', 'shariq',
  'shoaib', 'sikandar', 'sohail', 'suhail', 'tabrez', 'tahir', 'tanveer', 'tariq', 'tauseef',
  'wahid', 'waqar', 'wasim', 'yaseen', 'yasin', 'younus', 'yusuf', 'zaheer', 'zahid', 'zain',
  'zakir', 'zeeshan',
  'amitava', 'anirban', 'ansuman', 'arindam', 'ashoke', 'asit', 'barun', 'biman',
  'biplab', 'debashish', 'debjit', 'debojit', 'dipak', 'diptesh', 'gautam', 'gopinath',
  'indranil', 'jayanta', 'joydeep', 'kaushik', 'koushik', 'malay', 'mrinal', 'partha',
  'prasenjit', 'pritam', 'rajarshi', 'rananjay', 'ranajit', 'sabyasachi',
  'sanjib', 'sayan', 'sekhar', 'shantanu', 'shubhankar', 'somnath', 'soumen', 'soumik',
  'soumitra', 'souvik', 'subhankar', 'subhas', 'subhro', 'sudip', 'sugato', 'suman',
  'sumanta', 'suvojit', 'tanmoy', 'tapan', 'tathagata',
  'ajit', 'amol', 'anant', 'ashwin', 'bhargav', 'chirag', 'chintan', 'devang', 'dhiraj',
  'dhruvin', 'gopalkrishna', 'hemal', 'jay', 'jayraj', 'jignesh',
  'kalpesh', 'ketan', 'khushal', 'kiran', 'krunal', 'mihir', 'milan', 'mitesh', 'mrunal',
  'nayan', 'nilay', 'nimesh', 'nirav', 'nishith', 'parag', 'parimal', 'pratham',
  'rajan', 'rushabh', 'sanket', 'sarvesh', 'shailesh', 'sharad', 'siddhesh',
  'snehal', 'sujal', 'tushar', 'vatsal', 'vishwas', 'yagnesh',
  'anbarasan', 'anbu', 'anirudh', 'ashwin', 'balaji',
  'balamurugan', 'balasubramaniam', 'bharath', 'chandrasekhar', 'chandru', 'dinakaran',
  'elango', 'gopalakrishnan', 'govind', 'guru', 'gurumurthy', 'harish',
  'jagadish', 'jayakumar', 'kannan', 'karthikeyan', 'krishnamurthy',
  'krishnan', 'kumar', 'madhavan', 'madhu', 'mahendran', 'manikandan', 'manoharan',
  'manohar', 'mohanraj', 'murali', 'murugan', 'muthu', 'nagarajan', 'narsimha',
  'natarajan', 'nataraj', 'niranjan', 'pandiarajan', 'prabhakaran',
  'rajagopal', 'rajendran',
  'ramachandran', 'ramakrishnan', 'ramanathan', 'ranganathan', 'ravichandran',
  'ravikumar', 'sampath', 'saravanan', 'satheesh', 'selvakumar',
  'selvam', 'senthil', 'senthilkumar', 'shanmugam', 'shivakumar', 'sivakumar',
  'sreekanth', 'sreenivas', 'srikanth', 'srinath', 'srinivas', 'srinivasan', 'subbu',
  'subramaniam', 'subramanian', 'sudhakar', 'sundar', 'sundaram', 'sundareshan',
  'thangaraj', 'thiru', 'thiyagarajan', 'udayakumar', 'vasanth', 'vasudevan',
  'veeraraghavan', 'veerappan', 'vellingiri', 'venkatesan', 'venkatesh', 'venkataraman',
  'vignesh', 'vijayakumar', 'vijayan', 'vinayak', 'vishwanath',
  'adi', 'cyrus', 'darius', 'farokh', 'jamshed', 'jehangir', 'kaizad', 'khushru', 'noshir',
  'rustom', 'sohrab', 'zubin',
  'alwyn', 'anthony', 'benjamin', 'clement', 'clifford', 'derek',
  'edwin', 'felix', 'francis', 'ivan', 'jerome', 'joel', 'john', 'joseph', 'joshua',
  'lawrence', 'leon', 'lester', 'lloyd', 'mathew', 'matthew', 'melvin', 'michael', 'nelson',
  'nigel', 'oscar', 'paul', 'peter', 'philip', 'ronald', 'roshan', 'russell', 'samuel',
  'simon', 'stanley', 'stephen', 'thomas', 'timothy', 'tony', 'vernon', 'victor', 'vincent',
  'walter', 'wilfred', 'william',
];

const CURATED_FEMALE = [
  'aadhya', 'aadya', 'aaliya', 'aaradhya', 'aarohi', 'aarti', 'aashi', 'aditi', 'aishwarya',
  'akanksha', 'alka', 'amrita', 'anamika', 'ananya', 'anita', 'anjali', 'anju', 'ankita', 'ayushi',
  'anshika', 'anupama', 'anushka', 'aparna', 'archana', 'arpita', 'arti', 'arushi', 'asha',
  'ashima', 'avantika', 'avni', 'bhavana', 'bhavya', 'bhumi', 'chahat', 'chandni', 'charu',
  'charvi', 'darshana', 'deepa', 'deepali', 'deepika', 'deepti', 'devika', 'dimple', 'disha',
  'divya', 'diya', 'garima', 'gauri', 'gayatri', 'geeta', 'geetika', 'gita', 'gunjan',
  'hansa', 'hema', 'ishani', 'ishita', 'jaya', 'jayanti', 'jyoti', 'jyotsna', 'kajal',
  'kalpana', 'kamala', 'kanchan', 'kanika', 'kavita', 'kavya', 'khushi', 'komal',
  'kritika', 'kusum', 'lakshmi', 'lata', 'laxmi', 'madhavi', 'madhu', 'madhuri', 'mahi',
  'mala', 'malini', 'mamta', 'mandira', 'manisha', 'mansi', 'maya', 'meena', 'meenakshi',
  'meera', 'mina', 'mohini', 'monika', 'mrinalini', 'mugdha', 'mukta', 'myra', 'nandini',
  'nandita', 'natasha', 'navya', 'neelam', 'neelima', 'neena', 'neeraja', 'neerja', 'neeru',
  'neetu', 'neha', 'nidhi', 'niharika', 'nikita', 'nilima', 'nina', 'nirmala', 'nisha',
  'nishtha', 'nitya', 'niyati', 'padma', 'padmini', 'palak', 'pallavi', 'pari', 'parul',
  'parvati', 'payal', 'pinky', 'pooja', 'poonam', 'prachi', 'pragati', 'pragya', 'prakriti',
  'pratibha', 'preeti', 'prerna', 'priti', 'priya', 'priyanka', 'punam', 'purnima',
  'radha', 'radhika', 'rajni', 'rakhi', 'rama', 'rani', 'ranjana', 'ratna', 'reena', 'reeta',
  'rekha', 'renu', 'renuka', 'richa', 'riddhi', 'ritu', 'riya', 'ruchi', 'ruchika',
  'rashmi', 'rukmini', 'rupa', 'rupali', 'sadhana', 'sakshi', 'sana', 'sangeeta', 'sanjana',
  'sheetal', 'shibani',
  'sanskriti', 'sapna', 'saraswati', 'sarika', 'sarita', 'sarla', 'sarojini', 'saroj',
  'saumya', 'seema', 'shalini', 'shanta', 'shanti', 'sharda', 'sharmila', 'sharmistha',
  'shefali', 'shikha', 'shilpa', 'shipra', 'shivani', 'shraddha', 'shreya', 'shri',
  'shruti', 'shubhra', 'shweta', 'sindhu', 'sita', 'smita', 'smriti', 'sneha',
  'snigdha', 'sonali', 'sonam', 'sonia', 'sudha', 'suhasini', 'suman', 'sumati', 'sumitra',
  'sunaina', 'sunanda', 'sunita', 'suparna', 'supriya', 'surabhi', 'sushila', 'sushma',
  'sveta', 'swati', 'tania', 'tanisha', 'tanu', 'tanuja', 'tanvi', 'tanya', 'tara',
  'trisha', 'trupti', 'uma', 'urmila', 'urvashi', 'usha', 'vaishali', 'vandana', 'vanita',
  'vanya', 'varsha', 'vasudha', 'veena', 'vibha', 'vidya', 'vimla', 'vineeta', 'vinita',
  'vrinda', 'yamini', 'yashika', 'yashoda', 'yashvi', 'zara',
  'amandeep', 'amreen', 'amrit', 'baljeet', 'gurleen', 'gurpreet', 'harleen', 'harmeet',
  'harsimran', 'inderpreet', 'jasleen', 'jaspreet', 'jasween', 'jyotpreet', 'kirandeep',
  'kirat', 'navdeep', 'navjot', 'navpreet', 'parneet', 'prabhleen', 'rajwinder', 'ramandeep',
  'ravneet', 'simran', 'sukhleen', 'taranjeet',
  'aafreen', 'aaisha', 'aiman', 'aisha', 'alia', 'alina', 'amara', 'ambreen',
  'ameena', 'amina', 'anisa', 'arifa', 'asma', 'ayesha', 'azra', 'bushra',
  'faiza', 'farah', 'farheen', 'farida', 'farzana', 'fatima', 'firdaus', 'gulnaz',
  'hina', 'humaira', 'huma', 'iqra', 'ishrat', 'jahanara', 'kainat', 'khadija',
  'khushnuma', 'mahek', 'maheen', 'mahjabeen', 'mariam', 'maryam', 'mehjabeen', 'mehreen',
  'mehrunissa', 'misbah', 'mumtaz', 'naaz', 'nafisa', 'najma', 'nargis', 'nasreen', 'naushaba',
  'nazia', 'nazneen', 'nida', 'nikhat', 'nilofer', 'noorjahan', 'noor', 'parveen', 'raheela',
  'rakhshanda', 'rehana', 'rifat', 'roshni', 'rubina', 'rukhsana', 'rukhsar', 'rushda',
  'saba', 'sabiha', 'sadaf', 'sahar', 'saima', 'saira', 'salma', 'samina', 'samreen',
  'sania', 'shabana', 'shabnam', 'shaheen', 'shahnaz', 'shaista', 'shakila',
  'shazia', 'sultana', 'tabassum', 'tahira', 'tanzeela', 'tasneem', 'yasmeen', 'yasmin',
  'zainab', 'zarina', 'zeba', 'zoya',
  'anindita', 'aparajita', 'baishakhi', 'barnali', 'bidisha', 'chaitali',
  'debarati', 'debolina', 'ipsita', 'jayashree', 'kakoli', 'koyel', 'mahasweta',
  'mahua', 'mallika', 'mampi', 'manasi', 'mausumi', 'mimi', 'mitali', 'moushumi',
  'oindrila', 'paromita', 'piyali', 'purba', 'rangana', 'rimjhim', 'ritwika',
  'rupsa', 'sagarika', 'sohini', 'srabani', 'srijita', 'sriparna', 'suchitra',
  'sudeshna', 'sukanya', 'sulagna', 'sutapa', 'swagata', 'tanushree', 'tiyasha', 'trina',
  'bhavika', 'bhoomi', 'devanshi', 'dhara',
  'foram', 'heena', 'hetal', 'jinal', 'khyati', 'krupa', 'kruti',
  'meghna', 'nayana', 'neepa', 'nirali', 'poorvi', 'priyal', 'rachana', 'ridhi',
  'rima', 'rutuja', 'urvi', 'vaishnavi', 'vidhi', 'yesha',
  'akhila', 'ambika', 'ammu', 'anitha', 'anjana', 'anjaneyulu',
  'aruna', 'arundhati', 'bhagya', 'bhagyalakshmi',
  'bhanu', 'bhanumathi', 'bharathi', 'bhavani', 'chaitra', 'chandana', 'chandrika',
  'devayani', 'devi', 'dhanalakshmi', 'dhanya', 'gayathri',
  'geetha', 'gowri', 'harini', 'indira', 'jayalakshmi', 'jayanthi',
  'kalyani', 'kamakshi', 'kaveri', 'keerthana', 'keerthi', 'lalitha',
  'latha', 'lavanya', 'mahalakshmi', 'malathi', 'malavika',
  'mangala', 'mythili', 'nagalakshmi', 'nandhini',
  'padmavathi', 'parvathi', 'poornima', 'pramila',
  'preethi', 'rajalakshmi', 'rajeswari',
  'ramya', 'ranjani', 'ranjitha', 'rathika', 'revathi', 'sahana', 'sandhya',
  'sangeetha', 'saranya', 'saraswathi', 'sarayu', 'saroja', 'sasikala',
  'shanthi', 'sharada', 'shashikala', 'shobha', 'shobhana',
  'shubha', 'sireesha', 'sowmya', 'sridevi', 'srilatha',
  'srividya', 'subbulakshmi', 'sujata', 'sujatha', 'sulochana',
  'sumathi', 'suma', 'sunitha', 'suvarna', 'swapna', 'swarna', 'swathi',
  'swetha', 'thanuja', 'umadevi', 'vaidehi', 'vani',
  'vanitha', 'varalakshmi', 'vasanthi', 'veda', 'vidhya',
  'vijaya', 'vijayalakshmi', 'vimala', 'yamuna',
  'aban', 'aloo', 'avan', 'bapsy', 'dilnaz', 'freny', 'goolnar', 'homai',
  'shirin', 'tanaz', 'zarine',
  'agnes', 'angela', 'ann', 'annie', 'beatrice', 'bernadette', 'carol',
  'catherine', 'celine', 'cynthia', 'diana', 'dolly', 'elizabeth', 'esther', 'flora',
  'grace', 'jasmine', 'jennifer', 'jessica', 'joanna', 'josephine', 'julia', 'juliet',
  'kristina', 'lilian', 'lily', 'lisa', 'lorna', 'lucy', 'maria', 'marina', 'martha',
  'mary', 'monica', 'nancy', 'natalie', 'nicole', 'olivia', 'pearl', 'philomena',
  'priscilla', 'rachel', 'rebecca', 'rosaline', 'rose', 'ruth', 'sabrina', 'sandra',
  'sarah', 'sharon', 'stella', 'susan', 'sylvia', 'teresa', 'theresa', 'veronica',
  'wendy',
];

const CURATED_AMBIGUOUS = [
  'kiran', 'simran', 'amanpreet', 'manpreet', 'jaspreet', 'harpreet', 'gurpreet',
  'sukhpreet', 'rupinder', 'amandeep', 'baljeet', 'chandra', 'krishna',
];

// A first name individually confirmed wrong from a low sample size in the
// source data (the dataset only ever observed it paired with a Kaur/Singh
// surname that doesn't reflect the general population) — see
// genderClassifier.ts's own comments on Kulvinder/Amritpal/Daljit for the
// real production records that surfaced these. Applied AFTER both the
// automatic dataset resolution AND the curated dictionary above, so it
// survives a re-run regardless of what either source says. Add to this list
// (not the generated JSON directly) for any future individually-confirmed
// correction.
const MANUAL_OVERRIDES: Record<string, 'M' | 'F' | 'AMBIGUOUS'> = {
  amritpal: 'AMBIGUOUS',
};

const MIN_MAJORITY_RATIO = 5;
const MIN_TOTAL_OCCURRENCES = 5;

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function tallyFirstNames(csv: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = csv.split('\n').slice(1); // skip header
  for (const line of lines) {
    if (!line.trim()) continue;
    const rawName = line.split(',')[0];
    if (!rawName) continue;
    const first = extractFirstName(rawName);
    if (!first || first.length < 2 || !/^[a-z]+$/.test(first)) continue;
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  return counts;
}

async function main() {
  console.log(`Fetching ${SOURCES.length} source dataset(s)...`);
  const tallies = await Promise.all(SOURCES.map(async s => ({
    gender: s.gender,
    counts: tallyFirstNames(await fetchCsv(s.url)),
  })));

  const maleCounts = tallies.filter(t => t.gender === 'M').reduce((acc, t) => {
    for (const [name, n] of t.counts) acc.set(name, (acc.get(name) || 0) + n);
    return acc;
  }, new Map<string, number>());
  const femaleCounts = tallies.filter(t => t.gender === 'F').reduce((acc, t) => {
    for (const [name, n] of t.counts) acc.set(name, (acc.get(name) || 0) + n);
    return acc;
  }, new Map<string, number>());

  console.log(`Unique first names — male: ${maleCounts.size}, female: ${femaleCounts.size}`);

  const maleSet = new Set<string>(CURATED_MALE);
  const femaleSet = new Set<string>(CURATED_FEMALE);
  const ambiguousSet = new Set<string>(CURATED_AMBIGUOUS);

  const allNames = new Set([...maleCounts.keys(), ...femaleCounts.keys()]);
  for (const name of allNames) {
    if (ambiguousSet.has(name)) continue; // curated ambiguity always wins
    const m = maleCounts.get(name) || 0;
    const f = femaleCounts.get(name) || 0;
    if (m > 0 && f > 0) {
      const ratio = Math.max(m, f) / Math.min(m, f);
      if (ratio >= MIN_MAJORITY_RATIO && m + f >= MIN_TOTAL_OCCURRENCES) {
        (m > f ? maleSet : femaleSet).add(name);
      } else {
        ambiguousSet.add(name);
      }
    } else if (m > 0) {
      maleSet.add(name);
    } else {
      femaleSet.add(name);
    }
  }

  // Residual conflicts between the curated dictionary and the dataset's own
  // resolution (e.g. a name this module's curators filed under one gender
  // that the dataset resolves confidently to the other) move to ambiguous
  // rather than silently picking a side — this is exactly how the original
  // "kiran" bug (present in both curated lists at once) was caught.
  for (const name of [...maleSet]) {
    if (femaleSet.has(name)) ambiguousSet.add(name);
  }

  for (const [name, verdict] of Object.entries(MANUAL_OVERRIDES)) {
    maleSet.delete(name);
    femaleSet.delete(name);
    ambiguousSet.delete(name);
    if (verdict === 'M') maleSet.add(name);
    else if (verdict === 'F') femaleSet.add(name);
    else ambiguousSet.add(name);
  }
  for (const name of ambiguousSet) {
    maleSet.delete(name);
    femaleSet.delete(name);
  }

  console.log(`Resolved — male: ${maleSet.size}, female: ${femaleSet.size}, ambiguous: ${ambiguousSet.size}`);

  const dataDir = path.join(__dirname, '../data');
  fs.writeFileSync(path.join(dataDir, 'indianMaleNames.json'), JSON.stringify([...maleSet].sort()));
  fs.writeFileSync(path.join(dataDir, 'indianFemaleNames.json'), JSON.stringify([...femaleSet].sort()));
  fs.writeFileSync(path.join(dataDir, 'indianAmbiguousNames.json'), JSON.stringify([...ambiguousSet].sort()));
  console.log(`Wrote updated dictionaries to ${dataDir}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
